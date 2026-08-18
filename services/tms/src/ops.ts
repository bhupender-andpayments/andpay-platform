import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import { toUuid } from '@andpay/ids'
// D-8: DETECTION only. The same rule fulfillment corrects with, so the count
// TMS reports is exactly what gets rewritten downstream. See the package.
import { hasEncodedSeparator } from '@andpay/bank-qr'
import type { TmsDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole, enterWriteScope } from './write-context.js'
import {
  ingestRequestRowWithinTx,
  requestRowRejectReason,
  seedKnownVpaOriginals,
  duplicateVpaVerdicts,
  vpaKey,
  type BankRequestRow,
  type RequestRowRejectReason,
  type DuplicateVpaOriginal,
} from './ingest.js'
import { CASE_STATUS_VALUES, normalizeCaseStatus } from './damage-case.js'

// The cap on an operator's case note, matching the trigger-note and hold-reason
// caps elsewhere: long enough for a real explanation, short enough that the
// column is a note and not a document store.
const MAX_OPS_REMARKS_LENGTH = 500
import { parseBankRequestFile, type StructuralParseError } from './bank-file-adapter.js'
import { createDamageReasonWithinTx, setDamageReasonActiveWithinTx, type DamageReasonRow } from './damage-reason.js'
import { activateAssignmentWithinTx } from './assignment.js'
import { recordActivationStatusWithinTx } from './activation-branch.js'
import type { DevicePort } from './device-port.js'

// Fix wave 1 (fulfillment/src/ops.ts, Task 9 review, Important 1) equivalent
// for TMS: a discriminated client-error for an expected client condition (a
// caller-supplied value that fails validation), so the ops HTTP edge's
// app-wide OpsErrorFilter can map it to a 4xx via duck-typing on `kind`
// (the filter's comment names this exact future addition, "a future tms
// equivalent needs no new import here"). `kind` started as the single
// 'invalid' this domain threw in v1; the flag-damage write (D-26, DP-3)
// widened it with 'not-found' (an unknown target dispatch, the same kind
// fulfillment already throws) and 'conflict' (a live damage case already
// exists, the 409 the edge maps it to).
export class OpsClientError extends Error {
  constructor(
    public readonly kind: 'invalid' | 'not-found' | 'conflict',
    message: string,
  ) {
    super(message)
  }
}

// Fix-round 1 (review finding, Minor): a duplicate create (same code or
// normalized label, a different Idempotency-Key so `onceWithin` does not
// dedup it away) previously threw the RAW Prisma/Postgres unique-violation
// error, which bypasses OpsErrorFilter's duck-type check (no `kind`
// property) and falls through to a 500. createDamageReasonWithinTx uses raw
// `$queryRaw` (not the typed client), so a constraint violation surfaces
// DIFFERENTLY than the typed-client P2002 shape other services check for
// (services/auth/src/vendor-operator.ts's isUniqueViolation): Prisma wraps a
// failed raw query as `PrismaClientKnownRequestError` with the top-level
// `code` fixed at 'P2010' ("raw query failed") and the ORIGINAL Postgres
// SQLSTATE inside `meta.code` (verified empirically against this exact
// INSERT: `{ code: 'P2010', meta: { code: '23505', message: 'Key (code)=(...)
// already exists.' } }`). '23505' is Postgres's unique_violation SQLSTATE,
// so this checks that, not 'P2002'.
function isRawUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  if ((err as { code?: unknown }).code !== 'P2010') return false
  const meta = (err as { meta?: unknown }).meta
  return typeof meta === 'object' && meta !== null && 'code' in meta && (meta as { code?: unknown }).code === '23505'
}

// A structural parse failure (unsupported extension, unreadable bytes, or a
// missing required column) on a COMMIT: the file cannot be ingested at all, so
// nothing is written. `kind: 'invalid'` is the discriminant the ops-edge
// OpsErrorFilter duck-types on to return a 400 (no new edge import needed); the
// structural detail rides the thrown error for the caller/log, never the DB.
export class BankFileParseError extends Error {
  readonly kind = 'invalid' as const
  readonly structuralErrors: StructuralParseError[]
  constructor(structuralErrors: StructuralParseError[]) {
    super('bank file failed structural parse')
    this.name = 'BankFileParseError'
    this.structuralErrors = structuralErrors
  }
}

// One preview row result: the row's 1-based data index, whether it passes the
// SAME S8 row validators the commit path runs, the reason codes on failure,
// and the parsed row itself. The row content (bank PII) travels ONLY in this
// response object; it is never persisted and never logged (S4/5c).
export interface PreviewRowResult {
  rowNo: number
  valid: boolean
  errors: RequestRowRejectReason[]
  row: BankRequestRow
  /**
   * Present only on a `duplicate_vpa_soundbox` verdict (ruling 2026-08-10):
   * the record this row collides with, so the preview can say "VPA -> original"
   * instead of just "invalid".
   *
   * A SIBLING of `row` and never a field inside it, deliberately: the ops
   * portal's bank-file preview table derives its columns reflectively from
   * `Object.keys(rows[0].row)`, so anything added to `row` would silently become
   * a new column of that table, and this is not a bank-file column.
   *
   * Named as a surface rather than as a file path on purpose. This comment used
   * to cite BankUploadPage.tsx, which the workflow-workspace branch deleted when
   * the bank upload became stages 1 and 2 of the workflow rail, so the pointer
   * outlived the file by a whole branch. The contract is with whatever screen
   * renders that preview, not with a filename.
   */
  duplicateOf?: DuplicateVpaOriginal
}

export interface BankPreviewResult {
  rows: PreviewRowResult[]
  summary: { total: number; valid: number; invalid: number }
  // Whole-file structural problems (a preview surfaces them rather than
  // throwing, so the operator can see exactly what is wrong before a commit).
  structuralErrors: StructuralParseError[]
}

// The co-committed ALLOW 6e record (S15, spec 10c CC-1). Each TMS ops MUTATION
// enqueues its ALLOW authz.audit INSIDE the same domain transaction as the
// effect, into TMS's OWN outbox (the tms `outbox` table; NO cross-schema write,
// C4), so the 6e and the effect commit together (co-commit): a rolled-back
// effect leaves no 6e, and a client-key replay (the `onceWithin` callback never
// runs) emits no new 6e. This is the identical fulfillment shape (eventType
// 'authz.audit'); Auth drains BOTH context outboxes into the one ordered chain.
// IDs and enums ONLY (S7/S10.5): a TMS ops action carries no reasonCode and no
// step-up assurance (none is a C3 bypass).
function opsAllow(args: {
  operation: string
  principalId: string
  resourceIds: string[]
  traceId: string
}): AuthzAuditRecord {
  return {
    principalId: args.principalId,
    cls: 3,
    actorChannel: 'human-direct',
    operation: args.operation,
    decision: 'ALLOW',
    outcome: 'allowed',
    resourceIds: args.resourceIds,
    traceId: args.traceId,
  }
}

// spec 10c ops writes (Task 5). These are the TMS-side handlers the ops HTTP
// edge (T9) calls in-process; the ops principal is class-3 human (D-3), never
// a vendor. Each opens ONE transaction and sets the role FIRST via a plain
// `SET LOCAL ROLE tms_write`, not `enterWriteScope`: the bank-file ingest
// writes only the permissive S8 ledger tables (pending_row / quarantine_row /
// ingest_file), which carry no program_id gate, so there is no single Program
// to bind into app.program_id for the whole action.
//
// Each action is one client-key idempotent instance (rule 1, 06.A) via the
// shared E6 inbox (`onceWithin`): a replay of the same clientKey does not
// re-run the loop, so the returned tally is the zero tally the counters
// already start at.

// Phase 2 Task 2 (D-K): the SERVER-SIDE preview of a bank request file. Parses
// the raw file via the Task 1 adapter and runs the SAME S8 row validators the
// commit path runs (requestRowRejectReason, the single source in ingest.ts),
// returning a per-row valid/invalid verdict plus a summary. The parsed rows
// (bank PII) live only in the returned object. The fileId here is a fixed
// non-identifying placeholder: it only ever appears inside the returned rows'
// correlation shape and never reaches a store, so no clientKey and no
// client-supplied value is needed.
//
// PERSIST-NOTHING, BUT NO LONGER DB-FREE (ruling 2026-08-10). This used to open
// no transaction and touch no DB at all. The soundbox duplicate-VPA gate is a
// verdict the commit path will reach, so a preview that could not see it would
// show a row as valid and then quarantine it on commit, which is exactly the
// surprise a preview exists to prevent. It therefore READS (never writes) the
// SAME seed the commit path reads, via seedKnownVpaOriginals under the
// read-only tms_ops_read role. Nothing else changed: no pending_row,
// quarantine_row, ingest_file, inbox or outbox row is written, no write role is
// entered, no 6e is enqueued, and NOTHING is logged.
//
// A READ is not persistence: nothing about the write plane moved.
export async function previewBankFile(db: TmsDb, fileBytes: Uint8Array, filename: string): Promise<BankPreviewResult> {
  const parsed = await parseBankRequestFile(fileBytes, filename, 'preview')
  if (parsed.errors.length > 0) {
    return { rows: [], summary: { total: 0, valid: 0, invalid: 0 }, structuralErrors: parsed.errors }
  }
  const seed = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    return seedKnownVpaOriginals(tx, parsed.rows.map((r) => r.vpaValue))
  })
  // The SAME pure walk the commit path runs over the SAME seed, so preview and
  // commit cannot disagree about which rows will be held.
  const verdicts = duplicateVpaVerdicts(parsed.rows, seed)
  const rows: PreviewRowResult[] = parsed.rows.map((row) => {
    // Format still wins first, mirroring ingestRequestRowWithinTx's own order,
    // so the preview names the error the operator can actually fix.
    const reason = requestRowRejectReason(row)
    if (reason !== null) return { rowNo: row.rowNo, valid: false, errors: [reason], row }
    const held = verdicts.get(row.rowNo)
    if (held !== undefined) {
      return { rowNo: row.rowNo, valid: false, errors: ['duplicate_vpa_soundbox'], row, duplicateOf: held }
    }
    return { rowNo: row.rowNo, valid: true, errors: [], row }
  })
  const valid = rows.reduce((n, r) => n + (r.valid ? 1 : 0), 0)
  return { rows, summary: { total: rows.length, valid, invalid: rows.length - valid }, structuralErrors: [] }
}

// Phase 2 Task 2 (D-K): the bank request-file COMMIT. Re-parses the raw file
// SERVER-SIDE via the Task 1 adapter (it never trusts a client-supplied rows
// array; the row shape is reconstructed here from the bytes), then runs the
// UNCHANGED S8 validate + partial-accept + quarantine + row-fact outbox logic
// under tms_write in one transaction, co-committing the ALLOW 6e exactly as
// before. Returns the same counts, plus the server-owned fileId.
//
// The fileId is the clientKey (the Idempotency-Key the edge already trusts as
// the per-operation identity). It is server-received (a header, never the
// request body, M7/S16), and deterministic across a replay: on a client-key
// replay `onceWithin` skips the body entirely, so the returned fileId still
// names the file that WAS ingested on the original call rather than a fresh
// unused id.
export async function commitBankFile(
  db: TmsDb,
  args: { fileBytes: Uint8Array; filename: string; clientKey: string; actorId: string; traceId: string },
): Promise<{
  accepted: number
  quarantined: number
  duplicate: number
  qrMalformed: number
  duplicateVpa: number
  duplicateMobile: number
  // Ruling 2026-08-10, ADDITIVE: the soundbox rows this file HELD for a repeat
  // VPA, each naming the record it collides with. Separate from duplicateVpa
  // (which stays a count of every repeat, held or not) because the operator
  // needs the row numbers to act on, and because an empty list is the honest
  // shape for a file that repeated a VPA on sticker/standee rows only.
  duplicateVpaHeld: { rowNo: number; duplicateOf: DuplicateVpaOriginal }[]
  fileId: string
}> {
  const fileId = args.clientKey
  const parsed = await parseBankRequestFile(args.fileBytes, args.filename, fileId)
  if (parsed.errors.length > 0) throw new BankFileParseError(parsed.errors)

  const tally = { accepted: 0, quarantined: 0, duplicate: 0 }
  // D-8. How many rows of THIS file arrived with the bank's HTML-escaped QR
  // separator. The D4 ruling (BANK_FILE_DECISIONS_2026-08-07.md) ends "This is a
  // compensating control for a bank-side bug, not a fix. GSCB should still be
  // told", and this is the number to tell them. Without it the correction
  // fulfillment applies is silent, so nobody would learn if GSCB fixed their
  // export, or if they regressed after fixing it.
  //
  // COUNTING IS NOT ALTERING, so D117/T2 holds: TMS still stores and emits the
  // bank string verbatim and the fact stream keeps a faithful record of what
  // GSCB actually sent. The correction stays at fulfillment's artifact
  // boundaries, using the SAME @andpay/bank-qr rule, so this counts exactly what
  // that correction rewrites.
  //
  // Counted per ROW rather than per accepted row: the count is evidence about
  // what the BANK SENT, so a row we quarantine for an unrelated reason still
  // arrived malformed, and excluding it would understate the defect to GSCB.
  let qrMalformed = 0
  // D-2. How many rows carry a VPA we have seen before, either earlier in THIS
  // file or in an earlier upload. BRD 5.1b asks for exactly this ("detect
  // duplicates (same VPA / Mobile) in same upload or recent uploads) and flag
  // for review").
  //
  // A FLAG, NEVER A GATE, and that is Bhupender's ruling rather than a
  // shortcut: "repeat VPA can be flagged in the ingestion part ... the
  // additional soundbox request may or may not be." The same VPA arriving again
  // is the legitimate additional-soundbox case at least as often as it is a
  // mistake, so quarantining it would stall real orders waiting for a human,
  // and auto-accepting it silently would hide real duplicates. Reporting the
  // count is the only answer that serves both, which is why the BRD names the
  // duplicate rule and the additional-soundbox rule in a single sentence.
  //
  // SUPERSEDED FOR SOUNDBOX ROWS (ruling 2026-08-10). The flag-never-gate
  // reading above still stands for a STICKER/STANDEE row: those are never
  // rejected for a repeat VPA and keep these counters exactly as they were. A
  // SOUNDBOX row on a VPA we already serve is now HELD instead
  // (duplicate_vpa_soundbox, see ingest.ts), because a second device shipping to
  // a merchant who already has one is worth a human look BEFORE it ships, not
  // after.
  //
  // The COUNTERS below are unchanged for both kinds, held or not, exactly like
  // qrMalformed: they are evidence about what the FILE contained, and dropping a
  // held row from the tally would understate the repeat rate in the bank's
  // export. The list of held rows rides separately, on duplicateVpaHeld.
  //
  // Counted per ROW like qrMalformed, and the FIRST sighting is not a repeat:
  // only the second and later occurrences count, so a clean file reports 0.
  let duplicateVpa = 0
  // The Mobile half of the same BRD rule, counted DIFFERENTLY on purpose.
  //
  // A repeat VPA is the same merchant returning. A repeat MOBILE on a DIFFERENT
  // VPA is two distinct merchants sharing a contact number: one owner with two
  // shops, a shared shopkeeper phone, or a typo. Only the second is news, and it
  // is invisible to the VPA check.
  //
  // So a mobile is flagged ONLY when the VPA beside it is new. The same merchant
  // reappearing repeats its mobile BY DEFINITION, and counting that here would
  // double-report one benign situation under two alarming headings, which is how
  // an operator learns to ignore both flags.
  //
  // MEASURED in the real 360-row GSCB file: 3 mobiles repeat and ALL 3 are
  // across different VPAs, while zero VPAs repeat. This is the flag that
  // actually fires on real data.
  let duplicateMobile = 0
  // Ruling 2026-08-10: the held soundbox rows, named. Declared out here beside
  // the counters so it survives the transaction, and left EMPTY on a client-key
  // replay for the same reason the counters are zero then (the onceWithin body
  // never runs).
  const duplicateVpaHeld: { rowNo: number; duplicateOf: DuplicateVpaOriginal }[] = []
  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:upload-bank-file'), async () => {
      // Seeded with the VPAs TMS already holds, so "recent uploads" is covered
      // and not just "this file". Both tables are TMS's own (no cross-context
      // read): pending_row is a row awaiting identity, assignment is one that
      // already became an order. Read once rather than per row.
      const seenVpa = new Set<string>()
      // mobile -> the VPAs it has been seen with, so "a DIFFERENT merchant on
      // this number" is answerable rather than just "this number again".
      const seenMobile = new Map<string, Set<string>>()
      const fileVpas = parsed.rows.map((r) => r.vpaValue).filter((v) => v !== '')
      const fileMobiles = parsed.rows.map((r) => r.mobile).filter((m): m is string => typeof m === 'string' && m !== '')
      if (fileVpas.length > 0 || fileMobiles.length > 0) {
        const known = await tx.$queryRaw<{ vpa_value: string; mobile: string | null }[]>`
          SELECT vpa_value, mobile FROM pending_row
            WHERE vpa_value = ANY(${fileVpas}::text[]) OR mobile = ANY(${fileMobiles}::text[])
          UNION
          SELECT vpa_value, mobile FROM assignment
            WHERE vpa_value = ANY(${fileVpas}::text[]) OR mobile = ANY(${fileMobiles}::text[])
        `
        for (const k of known) {
          const key = vpaKey(k.vpa_value)
          seenVpa.add(key)
          if (k.mobile !== null && k.mobile !== '') {
            const vpas = seenMobile.get(k.mobile) ?? new Set<string>()
            vpas.add(key)
            seenMobile.set(k.mobile, vpas)
          }
        }
      }

      // Ruling 2026-08-10, the soundbox duplicate-VPA gate. A SECOND seed read
      // rather than a reuse of seenVpa above: both now key on vpaKey, but that
      // set answers only "seen before" and is mixed with the mobile walk,
      // whereas the gate needs the ORIGINAL record (which table, its reference,
      // the merchant name). Merging them would make the counter's semantics
      // depend on the gate's.
      const vpaOriginals = await seedKnownVpaOriginals(tx, parsed.rows.map((r) => r.vpaValue))
      // Computed for the WHOLE file up front, from the same pure walk the
      // preview runs, so the two surfaces cannot disagree.
      const verdicts = duplicateVpaVerdicts(parsed.rows, vpaOriginals)

      for (const row of parsed.rows) {
        if (hasEncodedSeparator(row.qrValue)) qrMalformed += 1
        // Both counters compare merchants by vpaKey, the same lowercased key
        // D1 mints merchant identity from (`v1:vpa:<lower(vpa)>`) and the same
        // key the gate below uses. Comparing the raw strings, as this did until
        // 2026-08-10, treated `ACME@psp` and `acme@psp` as two merchants: it
        // undercounted the repeat, and worse, told the shared-mobile check that
        // one merchant's own number now belonged to a second merchant.
        const rowVpaKey = vpaKey(row.vpaValue)
        if (rowVpaKey !== '') {
          if (seenVpa.has(rowVpaKey)) duplicateVpa += 1
          seenVpa.add(rowVpaKey)
        }
        if (typeof row.mobile === 'string' && row.mobile !== '') {
          const vpas = seenMobile.get(row.mobile)
          // Seen before, AND with some OTHER merchant: that is the shared-number
          // case. Seen before with only THIS vpa is the same merchant returning,
          // already reported as duplicateVpa.
          if (vpas !== undefined && [...vpas].some((v) => v !== rowVpaKey)) duplicateMobile += 1
          const next = vpas ?? new Set<string>()
          next.add(rowVpaKey)
          seenMobile.set(row.mobile, next)
        }
        const verdict = verdicts.get(row.rowNo) ?? null
        const outcome = await ingestRequestRowWithinTx(tx, row, args.traceId, verdict)
        tally[outcome] += 1
        // Held FOR the duplicate, not merely quarantined while also being one.
        // All three conditions are load-bearing:
        //   - `quarantined` and not 'duplicate': a row already quarantined under
        //     this (file_id, row_no) writes nothing the second time, so listing
        //     it would claim a hold this call did not make.
        //   - a verdict existed: the row is a repeat at all.
        //   - no format reason: format wins FIRST inside
        //     ingestRequestRowWithinTx, so a duplicate row that also fails a
        //     format rule is quarantined under the FORMAT reason, and naming it
        //     here would send the operator looking for the wrong problem.
        //     requestRowRejectReason is pure, so re-asking it costs nothing and
        //     keeps this exact rather than inferred from the outcome alone.
        if (outcome === 'quarantined' && verdict !== null && requestRowRejectReason(row) === null) {
          duplicateVpaHeld.push({ rowNo: row.rowNo, duplicateOf: verdict })
        }
      }
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the ingest.
      // A bank-file upload has no single target row id (it is file-level), so
      // resourceIds is empty.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:upload-bank-file',
            principalId: args.actorId,
            resourceIds: [],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { ...tally, qrMalformed, duplicateVpa, duplicateMobile, duplicateVpaHeld, fileId }
}

// Re-drives the S8 ingest for a corrected row, then stamps the SOURCE
// quarantine row resolved (A2: quarantine_row is otherwise append-only; this
// is the only mutation it ever receives). The corrected row is independent
// of the quarantine row's own (file_id, row_no): it lands wherever its own
// correlation id points, exactly like any other ingest.
//
// `deduped: true` means this call was a client-key replay (the E6 inbox
// already ran the effect on the original call, so this call re-runs
// nothing: no fresh ingest, no re-stamp of resolved_at/resolved_by_actor).
// `outcome` is only meaningful when `deduped` is false; on a replay it is
// `null`, which is unambiguous, unlike overloading the ingest-level
// `'duplicate'` outcome (a row-level dedup on correlation_id or
// (file_id, row_no)), which means something operationally different.
//
// `cured: false` means the correction did NOT land, so the hold STAYS in the
// queue. A cure is only a cure if the corrected row ingested, and this stamp
// used to run unconditionally, which lost real requests (18 Aug 2026): the
// resolve dialog pins fileId and rowNo to the row being cured, so a
// still-invalid correction re-quarantines straight into the
// ON CONFLICT (file_id, row_no) DO NOTHING of that very row, writes nothing,
// and reported 'duplicate'. The row was then retired as 'cured' while the
// merchant's request existed neither in pending_row nor as a fresh hold. An
// operator who wants a held row retired WITHOUT ingesting it has
// closeQuarantineRow for exactly that, which is why refusing here costs
// nothing: the two ways out stay distinct instead of one silently doing the
// other's job badly. Reported like closeQuarantineRow's `closed`, so a caller
// reads "it landed" from a flag rather than inferring it from a bare success.
export async function resolveQuarantineRow(
  db: TmsDb,
  args: { quarantineId: string; correctedRow: BankRequestRow; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; outcome: 'accepted' | 'quarantined' | 'duplicate' | null; cured: boolean }> {
  let outcome: 'accepted' | 'quarantined' | 'duplicate' | null = null
  let cured = false
  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:resolve-quarantine'), async () => {
      const ingested = await ingestRequestRowWithinTx(tx, args.correctedRow, args.traceId)
      outcome = ingested
      // ONLY an accepted ingest retires the hold. 'quarantined' means the
      // correction was itself held (as a new row when it carries a different
      // (file_id, row_no), or not at all when it collides with this one), and
      // 'duplicate' means nothing was written; in both cases the order is still
      // unfilled, so the row an operator has to act on must remain actionable.
      if (ingested === 'accepted') {
        const stamped = await tx.$queryRaw<{ id: string }[]>`
          UPDATE quarantine_row
          SET resolved_at = now(), resolved_by_actor = ${args.actorId}::uuid, resolution = ${'cured'}
          WHERE id = ${args.quarantineId}::uuid AND resolved_at IS NULL
          RETURNING id::text AS id
        `
        cured = stamped.length > 0
      }
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the re-ingest
      // and the resolved-at stamp, whether or not the cure landed: the operator
      // DID perform an authorized resolve attempt, and an audit that recorded
      // only the ones that landed would under-report what was tried (the same
      // reasoning closeQuarantineRow states for its own losing stamp).
      // The quarantine row is the target resource.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:resolve-quarantine',
            principalId: args.actorId,
            resourceIds: [args.quarantineId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { deduped: !ran, outcome, cured }
}

/**
 * CLOSE a held row: D-8's OTHER action, and the one that did not exist.
 *
 * "Close: it was a genuine duplicate (e.g. the bank typo'd Soundbox=Yes).
 * Record is closed and removed from the queue (retained in archive)." So this
 * ingests NOTHING. It is deliberately not resolveQuarantineRow with an empty
 * or synthetic row: re-driving an ingest to retire a record would either mint
 * an order nobody asked for or depend on a corrected row the operator does not
 * have, and both put a fabrication in the archive. The row is stamped resolved
 * with `resolution = 'closed'`, which is what keeps a closed record legible as
 * a decision rather than as a cure that happened to do nothing.
 *
 * WHY A SEPARATE PERMISSION AND OPERATION, not a flag on the existing one:
 * the co-committed 6e carries the operation, and "I archived a real order
 * unfilled" is a different claim from "I corrected and reprocessed it". One
 * operation string for both would make the audit trail unable to tell them
 * apart, which is precisely the distinction the new column exists to preserve.
 *
 * IDEMPOTENT AND SAFE AGAINST A RACE with cure, by the same means the rest of
 * this file uses: the client-key `onceWithin` makes a replay a no-op, and
 * `AND resolved_at IS NULL` in the UPDATE means a row someone else has already
 * cured is NOT re-stamped as closed. `closed: false` reports exactly that, so
 * the caller can tell "I closed it" from "it was already resolved" instead of
 * reading a bare success.
 */
export async function closeQuarantineRow(
  db: TmsDb,
  args: { quarantineId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; closed: boolean }> {
  let closed = false
  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:close-quarantine'), async () => {
      const stamped = await tx.$queryRaw<{ id: string }[]>`
        UPDATE quarantine_row
        SET resolved_at = now(), resolved_by_actor = ${args.actorId}::uuid, resolution = ${'closed'}
        WHERE id = ${args.quarantineId}::uuid AND resolved_at IS NULL
        RETURNING id::text AS id
      `
      closed = stamped.length > 0
      // Co-commit the ALLOW 6e in the SAME tx as the stamp (spec 10c CC-1),
      // whether or not the stamp won: the operator DID perform an authorized
      // close attempt against this resource, and an audit that recorded only
      // the winning attempts would under-report what was tried. IDs and enum
      // tokens only, no row content (S7/S10.5).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:close-quarantine',
            principalId: args.actorId,
            resourceIds: [args.quarantineId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { deduped: !ran, closed }
}

/**
 * D-16 (T4.1b): record that the activation request for these dispatch ids has
 * been SENT TO THE CWD.
 *
 * WHY THIS IS AN ACTION AND NOT A SIDE EFFECT OF THE REPORT. D-16 says report
 * generation is what sets REQUEST_SENT_TO_CWD, and the literal reading would put
 * a write inside GET /ops/reports/activation. That route is a pinned pure read
 * whose whole posture is that reads are not mutations, and a mutating GET is
 * also retried by every proxy and prefetched by every browser. So the same state
 * is written by an explicit operator act instead: "I have sent this batch to the
 * CWD", which is the claim the 6e should carry anyway. The domain write is this
 * one function either way, so moving the trigger later costs a route and no
 * state. Raised as a question rather than assumed (PLAN.md Q24).
 *
 * Takes a LIST because that is how the work happens: an operator exports a
 * worklist and sends it in one go, and stamping thirty rows through thirty
 * requests would leave a half-sent batch on any failure.
 *
 * The program for each row is resolved SERVER-SIDE from the assignment itself
 * (D99), never from the caller, and the write scope is entered per row because
 * the scope is per program and one send can span several. Unknown ids are
 * REPORTED rather than thrown on: a stale worklist naming a row that has since
 * been archived should not cost the operator the other twenty-nine.
 */
export async function requestActivationOps(
  db: TmsDb,
  args: { asgnIds: string[]; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; recorded: string[]; unknown: string[] }> {
  if (args.asgnIds.length === 0) {
    throw new OpsClientError('invalid', 'at least one dispatch id is required')
  }
  const recorded: string[] = []
  const unknown: string[] = []
  const ran = await db.$transaction(async (tx: Tx) => {
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:request-activation'), async () => {
      // ONE reported instant for the whole send, taken once: every row in this
      // batch left for the CWD together, and stamping each with its own
      // now() would put a spurious ordering in the trail.
      const occurredAt = new Date()
      for (const asgnId of args.asgnIds) {
        const target = await tx.$queryRaw<{ program_id: string }[]>`
          SELECT program_id::text AS program_id FROM assignment WHERE id = ${toUuid(asgnId)}::uuid
        `
        if (target.length === 0) {
          unknown.push(asgnId)
          continue
        }
        await enterWriteScope(tx, 'tms_write', target[0]!.program_id)
        await recordActivationStatusWithinTx(tx, {
          asgnId,
          programUuid: target[0]!.program_id,
          status: 'REQUEST_SENT_TO_CWD',
          occurredAt,
          statusSource: 'ops:request-activation',
          actorId: args.actorId,
          traceId: args.traceId,
        })
        recorded.push(asgnId)
      }
      // The ALLOW 6e co-commits in the SAME tx as the stamps (spec 10c CC-1),
      // naming every id the operator actually acted on. IDs and enum tokens
      // only (S7/S10.5).
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:request-activation',
            principalId: args.actorId,
            resourceIds: recorded,
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { deduped: !ran, recorded, unknown }
}

// Phase 3 Task 1 (BRD FR-08, FR-11) admin CRUD on the damage_reason master,
// the class-3 ops HTTP edge counterpart to createDamageReasonWithinTx /
// setDamageReasonActiveWithinTx (damage-reason.ts). Same shape as
// createVendorOps/suspendVendor in fulfillment/src/ops.ts: enters tms_write
// FIRST (the spec 10d landmine: role entry before onceWithin/co-commit),
// dedups on the client-key action instance via the shared E6 inbox
// (`onceWithin`), and co-commits the ALLOW 6e (spec 10c CC-1) in the SAME tx
// as the effect. damage_reason is platform-only (no program_id, permissive
// v1 RLS), so this enters the write role bare, exactly like
// createVendorOps/suspendVendor.

// Trims both fields (defense-in-depth against a caller-supplied all-
// whitespace value that would otherwise slip past the unique constraint as
// a distinct-looking row); rejects an empty code or label as a client error
// BEFORE opening the transaction.
export async function createDamageReasonOps(
  db: TmsDb,
  args: { code: string; label: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; damageReason: DamageReasonRow | null }> {
  const code = args.code.trim()
  const label = args.label.trim()
  if (code === '' || label === '') {
    throw new OpsClientError('invalid', 'code and label are required')
  }

  let damageReason: DamageReasonRow | null = null
  let ran: boolean
  try {
    ran = await db.$transaction(async (tx: Tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
      return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:damage-reason-create'), async () => {
        const created = await createDamageReasonWithinTx(tx, { code, label })
        damageReason = created
        // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the create.
        // The minted damage_reason id is the target resource (IDs only).
        await enqueue(
          tx,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:damage-reason-create',
              principalId: args.actorId,
              resourceIds: [created.id],
              traceId: args.traceId,
            }),
          ),
        )
      })
    })
  } catch (err) {
    // A duplicate code, OR a duplicate label under the normalized-unique
    // index (fix-round 1: "battery issue" vs "Battery Issue " both trip this
    // now), is an expected client condition, not a server fault: map it to a
    // clean 4xx via OpsClientError rather than letting the raw constraint
    // error reach the edge as a 500. The transaction rolled back (no
    // partial row, no orphaned 6e).
    if (isRawUniqueViolation(err)) {
      throw new OpsClientError('invalid', 'a damage reason with this code or label already exists')
    }
    throw err
  }
  return { deduped: !ran, damageReason: ran ? damageReason : null }
}

async function setDamageReasonActiveOps(
  db: TmsDb,
  operation: 'ops:damage-reason-activate' | 'ops:damage-reason-deactivate',
  active: boolean,
  args: { id: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, operation), async () => {
      await setDamageReasonActiveWithinTx(tx, args.id, active)
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the toggle.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation,
            principalId: args.actorId,
            resourceIds: [args.id],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { deduped: !ran }
}

export async function activateDamageReasonOps(
  db: TmsDb,
  args: { id: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  return setDamageReasonActiveOps(db, 'ops:damage-reason-activate', true, args)
}

// The reason this task exists (FR-08, FR-11): once a reason is deactivated,
// any LATER flag rejects it (flagDamageOps validates the CODE against active
// rows, flag-damage.ts) instead of creating a replacement; only replacements
// minted before deactivation are unaffected (this never touches assignment).
export async function deactivateDamageReasonOps(
  db: TmsDb,
  args: { id: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  return setDamageReasonActiveOps(db, 'ops:damage-reason-deactivate', false, args)
}

// FR08-2 (BRD 5.8): transition a replacement's damage case_status through the
// Open -> In-Progress -> Closed lifecycle. Any valid target is accepted (no
// transition graph is enforced: ops may legitimately reopen a Closed case).
// `assignment` is RLS-scoped (assignment_scoped: USING(true) WITH CHECK
// program_id = app.program_id), so unlike the platform-only damage_reason
// writes this must look the target's program up first (the USING(true) SELECT
// works before any program is bound) then enterWriteScope so the UPDATE's
// WITH CHECK passes. Role entry is FIRST (spec 10d landmine), the existence
// check throws BEFORE onceWithin (matching the create-path idiom of validating
// a client condition outside the deduped effect), and the ALLOW 6e co-commits
// in the SAME tx (spec 10c CC-1), wire ids only. Idempotent on the client key.
// Deliberately emits NO fact: projecting case_status into the analytics report/
// dashboard needs a new transition topic, a corpus decision deferred to a
// follow-up (see docs/plan/FR08_COMPLETION_DECISIONS.md).
export async function updateDamageCaseStatusOps(
  db: TmsDb,
  args: {
    asgnId: string
    newStatus: string
    // Workflow C step 1 (T6.4): what the OPERATOR wants recorded about this
    // case, distinct from the bank's own remarks on the damage row. Optional,
    // and an omitted value LEAVES THE EXISTING NOTE ALONE rather than clearing
    // it: a status change is not a reason to erase what somebody wrote. Passing
    // an empty string is the explicit clear.
    opsRemarks?: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ deduped: boolean }> {
  const target = normalizeCaseStatus(args.newStatus)
  if (target === undefined) {
    throw new OpsClientError('invalid', `case_status must be one of: ${CASE_STATUS_VALUES.join(', ')}`)
  }
  if (args.opsRemarks !== undefined && args.opsRemarks.length > MAX_OPS_REMARKS_LENGTH) {
    throw new OpsClientError('invalid', `opsRemarks must be ${MAX_OPS_REMARKS_LENGTH} characters or fewer`)
  }
  const asgnUuid = toUuid(args.asgnId)

  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'tms_write')
    const rows = await tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id FROM assignment WHERE id = ${asgnUuid}::uuid AND replacement_of IS NOT NULL
    `
    if (rows.length !== 1) {
      throw new OpsClientError('invalid', 'no such damage case (target must be a replacement assignment)')
    }
    const programId = rows[0]!.program_id
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:update-damage-case'), async () => {
      // enterWriteScope is deliberately INSIDE onceWithin (holdRecord scopes
      // before it): the onceWithin inbox INSERT runs with app.program_id unset,
      // which is fine because inbox/outbox are not program-gated (proven by
      // createDamageReasonOps, which never binds a program at all). Binding the
      // scope here, right before the UPDATE, keeps the WITH-CHECK program next
      // to the write it guards.
      await enterWriteScope(tx, 'tms_write', programId)
      // The remarks ride as a BOUND parameter and are never logged: operator
      // free text on a domain row, the same posture as batch.trigger_note.
      // COALESCE keeps an existing note when the caller sent none.
      await tx.$executeRaw`
        UPDATE assignment
        SET case_status = ${target},
            ops_remarks = COALESCE(${args.opsRemarks ?? null}, ops_remarks),
            updated_at = now()
        WHERE id = ${asgnUuid}::uuid
      `
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:update-damage-case',
            principalId: args.actorId,
            resourceIds: [args.asgnId],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { deduped: !ran }
}

// Phase 5 Task 2 (D-H.1, BRD Phase-1 MANUAL activation): the class-3 ops
// trigger for the TMS activation effect, the ops-edge counterpart to
// activateAssignment (the direct, non-audited entry point that stays test-
// only, section 2 of the grounding). Unlike updateDamageCaseStatusOps this
// does NOT duplicate the write body: it reuses activateAssignmentWithinTx
// (assignment.ts) and passes an onAudit callback so the 6e ALLOW co-commits
// INSIDE the same onceWithin as the UPDATE+fact. A redelivered/duplicate
// activation (already-activated assignment) is therefore a no-op for BOTH the
// domain effect and the audit, exactly like holdRecord; idempotency is the
// business key `${asgnId}|activate` (activateAssignmentWithinTx), NOT the
// caller's clientKey, so a double-activation is impossible regardless of the
// Idempotency-Key used.
//
// The DELIVERED gate is enforced by the CALLER (ops-edge, which holds the
// analyticsDb local projection, D-H.1's binding decision): this function
// trusts asgnId unconditionally and never reads analyticsDb itself (no
// cross-context DB read, C4).
export async function activateAssignmentOps(
  db: TmsDb,
  args: { asgnId: string; port: DevicePort; clientKey: string; actorId: string; traceId: string },
): Promise<{ activated: boolean }> {
  // Phase-1 manual flow: the device+SIM were already activated out of band by
  // the CWD; there is no separate device reference to carry here, so asgnId
  // doubles as the port command's deviceRef. ManualDevicePort ignores both
  // fields anyway (device-port.ts).
  const result = await args.port.activate({ asgnId: args.asgnId, deviceRef: args.asgnId })
  return db.$transaction((tx: Tx) =>
    activateAssignmentWithinTx(tx, args.asgnId, result.activatedAt, args.traceId, {
      // D-16: this door HAS an operator behind it, so the activation trail names
      // both rather than falling back to the port default.
      statusSource: 'ops:mark-activated',
      actorId: args.actorId,
      onAudit: (tx2) =>
        enqueue(
          tx2,
          buildAuthzAuditEvent(
            opsAllow({
              operation: 'ops:mark-activated',
              principalId: args.actorId,
              resourceIds: [args.asgnId],
              traceId: args.traceId,
            }),
          ),
        ),
    }),
  )
}
