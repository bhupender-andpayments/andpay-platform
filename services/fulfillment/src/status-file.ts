import { toUuid, fromUuid } from '@andpay/ids'
import { onceWithin } from '@andpay/outbox'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'
import { loadFulfillmentConfig } from './authz-config.js'
import { advanceShipmentStatus, isKnownStatus } from './courier-status.js'

export interface StatusRow {
  awb: string
  status: string
  courierTimestamp: string // ISO 8601
}
export interface StatusFile {
  fileId: string
  vndrId: string // the submitting courier's vndr_ wire id
  workQueue: string
  rows: StatusRow[]
}
export interface StatusFileResult {
  rejected?: 'unauthorized' | 'schema_invalid'
  advanced: number
  trailOnly: number
  quarantined: number
  deduped: boolean
}

function emptyResult(rejected: 'unauthorized' | 'schema_invalid'): StatusFileResult {
  return { rejected, advanced: 0, trailOnly: 0, quarantined: 0, deduped: false }
}

// Shape only (never throws on untrusted input): a missing or mistyped field, or
// an unparseable timestamp, fails the WHOLE file. Vocabulary (an unknown status
// token) is a per-row concern, checked inside the loop.
function isStructurallyValid(row: StatusRow): boolean {
  const r = row as unknown as Record<string, unknown>
  if (typeof r.awb !== 'string' || r.awb.length === 0) return false
  if (typeof r.status !== 'string' || r.status.length === 0) return false
  if (typeof r.courierTimestamp !== 'string') return false
  return !Number.isNaN(new Date(r.courierTimestamp).getTime())
}

async function quarantine(
  tx: Tx, vndrUuid: string, subjectRef: string, fileId: string, rowRef: string, reason: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO courier_status_exception (vndr_id, channel, subject_ref, file_id, row_ref, reason_code)
    VALUES (${vndrUuid}::uuid, ${'BATCH_FILE'}, ${subjectRef}, ${fileId}, ${rowRef}, ${reason})
  `
}

/**
 * Ingest a batch courier status file (C6 file-ingest, S8-untrusted). File-level
 * authorize gates the submitter as its own courier (105c) before any write; each
 * row then resolves shpt_ by AWB, enforces per-row courier ownership, and either
 * quarantines (103d, never auto-creates) or delegates to advanceShipmentStatus.
 */
export async function ingestStatusFile(
  db: FulfillmentDb, file: StatusFile, claim: LeanClaim, traceId: string,
): Promise<StatusFileResult> {
  // STEP A: file-level authorize BEFORE any transaction (S8, 105c own-vendor).
  const decision = authorize(claim, 'shipment:submit-status', { vndrId: file.vndrId, workQueue: file.workQueue }, loadFulfillmentConfig())
  if (!decision.allowed) return emptyResult('unauthorized')

  // STEP B: whole-file shape validation BEFORE any transaction.
  for (const row of file.rows) {
    if (!isStructurallyValid(row)) return emptyResult('schema_invalid')
  }

  const vndrUuid = toUuid(file.vndrId)
  let advanced = 0, trailOnly = 0, quarantined = 0

  // STEP C: file idempotency {vendor}|{fileId} via the inbox; a whole-file replay
  // does not run again (deduped).
  const ran = await db.$transaction(async (tx: Tx) => {
    // NAMED multi-program Fork-E exception (spec 10d Task 4, check 9): a batch
    // status file can legitimately carry shpts of MANY programs. Write-pinning
    // is PER WRITE, not per tx: enter fulfillment_write ONCE here (SET LOCAL
    // ROLE is transaction-scoped and persists across the per-shipment
    // set_config calls), then re-set app.program_id per shipment to THAT
    // shipment's OWN server-resolved program (AWB -> shpt -> program_id, never
    // a file column) right before delegating to advanceShipmentStatus. This is
    // deliberately NOT one enterWriteScope(role, oneProgram): a single GUC for
    // the whole tx would fail every non-last program's WITH CHECK (proven by
    // the (d) NEGATIVE assertion in test/write_role.test.ts). Unresolvable
    // rows quarantine (courier_status_exception, M-role) and never roll back
    // the file.
    await enterWriteRole(tx, 'fulfillment_write')
    return onceWithin(tx, CONSUMER, `${file.vndrId}|${file.fileId}`, async () => {
      for (let i = 0; i < file.rows.length; i++) {
        const row = file.rows[i]!
        const rowRef = `row-${i}`

        if (!isKnownStatus(row.status)) {
          await quarantine(tx, vndrUuid, row.awb, file.fileId, rowRef, 'unknown_status')
          quarantined++; continue
        }

        // shpt reads are open (USING true); no program context needed to
        // resolve. program_id is read here so the per-shipment write scope can
        // be pinned SERVER-SIDE to this shpt's OWN program (never a file column).
        const found = await tx.$queryRaw<{ program_id: string; courier_partner: string | null }[]>`
          SELECT program_id::text AS program_id, courier_partner::text AS courier_partner FROM shpt WHERE awb = ${row.awb}
        `
        if (found.length === 0) {
          await quarantine(tx, vndrUuid, row.awb, file.fileId, rowRef, 'unknown_awb')
          quarantined++; continue
        }
        const cp = found[0]!.courier_partner
        if (cp === null) {
          await quarantine(tx, vndrUuid, row.awb, file.fileId, rowRef, 'courier_unassigned')
          quarantined++; continue
        }
        // cp is already a native uuid string (selected ::text); compare on the wire id.
        if (fromUuid('vndr', cp) !== claim.scope.vndr) {
          await quarantine(tx, vndrUuid, row.awb, file.fileId, rowRef, 'wrong_courier')
          quarantined++; continue
        }

        // Per-shipment re-set: pin app.program_id to THIS shpt's own program
        // right before its scoped writes (advanceShipmentStatus writes the
        // M-pred shpt_status_event + shpt). advanceShipmentStatus is
        // program-agnostic; this caller owns the GUC.
        await setProgramContext(tx, found[0]!.program_id)

        const outcome = await advanceShipmentStatus(tx, {
          awb: row.awb,
          status: row.status,
          courierTimestamp: new Date(row.courierTimestamp),
          source: 'BATCH_FILE',
          sourceRef: `${file.vndrId}|${file.fileId}`,
          traceId,
        })
        if (outcome === 'advanced') advanced++
        else if (outcome === 'trail_only') trailOnly++
        // 'deduped' counts as neither; 'unknown_awb' is unreachable (checked above).
      }
    })
  })

  return { advanced, trailOnly, quarantined, deduped: !ran }
}
