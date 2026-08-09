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
  type BankRequestRow,
  type RequestRowRejectReason,
} from './ingest.js'
import { ingestDamageRowWithinTx, CASE_STATUS_VALUES, type BankDamageRow } from './damage.js'
import {
  parseBankRequestFile,
  parseBankDamageFile,
  type StructuralParseError,
} from './bank-file-adapter.js'
import { createDamageReasonWithinTx, setDamageReasonActiveWithinTx, type DamageReasonRow } from './damage-reason.js'
import { activateAssignmentWithinTx } from './assignment.js'
import type { DevicePort } from './device-port.js'

// Fix wave 1 (fulfillment/src/ops.ts, Task 9 review, Important 1) equivalent
// for TMS: a discriminated client-error for an expected client condition (a
// caller-supplied value that fails validation), so the ops HTTP edge's
// app-wide OpsErrorFilter can map it to a 4xx via duck-typing on `kind`
// (the filter's comment names this exact future addition, "a future tms
// equivalent needs no new import here"). `kind` is intentionally narrow
// (only the one shape this domain throws in v1): 'invalid' for a
// caller-supplied value that fails validation.
export class OpsClientError extends Error {
  constructor(
    public readonly kind: 'invalid',
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
// `SET LOCAL ROLE tms_write`, not `enterWriteScope`: the bank-file and
// damage-file ingests write only the permissive S8 ledger tables
// (pending_row / quarantine_row / ingest_file), which carry no program_id
// gate, so there is no single Program to bind into app.program_id for the
// whole action. `ingestDamageRowWithinTx` sets its OWN per-row
// app.program_id internally (for the program-scoped `assignment` write), so
// running many rows under one `tms_write` role-scope in a single transaction
// is still correct: each row sets its program right before its own writes.
//
// Each action is one client-key idempotent instance (rule 1, 06.A) via the
// shared E6 inbox (`onceWithin`): a replay of the same clientKey does not
// re-run the loop, so the returned tally is the zero tally the counters
// already start at.

// Phase 2 Task 2 (D-K): the SERVER-SIDE preview of a bank request file. Parses
// the raw file via the Task 1 adapter and runs the SAME S8 row validators the
// commit path runs (requestRowRejectReason, the single source in ingest.ts),
// returning a per-row valid/invalid verdict plus a summary. It is PURE and
// read-only in the strongest sense: it opens NO transaction, touches NO DB
// (no pending_row, quarantine_row, ingest_file, inbox, or outbox is written or
// even read), and logs NOTHING. The parsed rows (bank PII) live only in the
// returned object. The fileId here is a fixed non-identifying placeholder: it
// only ever appears inside the returned rows' correlation shape and never
// reaches a store, so no clientKey and no client-supplied value is needed.
export async function previewBankFile(fileBytes: Uint8Array, filename: string): Promise<BankPreviewResult> {
  const parsed = await parseBankRequestFile(fileBytes, filename, 'preview')
  if (parsed.errors.length > 0) {
    return { rows: [], summary: { total: 0, valid: 0, invalid: 0 }, structuralErrors: parsed.errors }
  }
  const rows: PreviewRowResult[] = parsed.rows.map((row) => {
    const reason = requestRowRejectReason(row)
    return { rowNo: row.rowNo, valid: reason === null, errors: reason === null ? [] : [reason], row }
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
): Promise<{ accepted: number; quarantined: number; duplicate: number; qrMalformed: number; duplicateVpa: number; duplicateMobile: number; fileId: string }> {
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
          seenVpa.add(k.vpa_value)
          if (k.mobile !== null && k.mobile !== '') {
            const vpas = seenMobile.get(k.mobile) ?? new Set<string>()
            vpas.add(k.vpa_value)
            seenMobile.set(k.mobile, vpas)
          }
        }
      }

      for (const row of parsed.rows) {
        if (hasEncodedSeparator(row.qrValue)) qrMalformed += 1
        if (row.vpaValue !== '') {
          if (seenVpa.has(row.vpaValue)) duplicateVpa += 1
          seenVpa.add(row.vpaValue)
        }
        if (typeof row.mobile === 'string' && row.mobile !== '') {
          const vpas = seenMobile.get(row.mobile)
          // Seen before, AND with some OTHER merchant: that is the shared-number
          // case. Seen before with only THIS vpa is the same merchant returning,
          // already reported as duplicateVpa.
          if (vpas !== undefined && [...vpas].some((v) => v !== row.vpaValue)) duplicateMobile += 1
          const next = vpas ?? new Set<string>()
          next.add(row.vpaValue)
          seenMobile.set(row.mobile, next)
        }
        const outcome = await ingestRequestRowWithinTx(tx, row, args.traceId)
        tally[outcome] += 1
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
  return { ...tally, qrMalformed, duplicateVpa, duplicateMobile, fileId }
}

// Phase 7 Task 7 (L11, FR08-3 decision item 11): the damage-file PREVIEW,
// built to give the damage upload the same preview-then-commit UX the bank
// upload already has. UNLIKE previewBankFile (a pure in-memory re-validate,
// zero DB touch), damage validation is a DB match by (bank_reference_code,
// vpa_value) against `assignment` plus an ACTIVE `damage_reason` label match
// (ingestDamageRowWithinTx's own two SELECTs) - a "pure preview cannot do
// this" per the ops.ts damage-commit comment above, so this function reads
// (never writes) those SAME two SELECTs under the read-only tms_ops_read
// role (the same role listDamageReasons/readDamageCases already use) and
// projects the identical outcome the commit path would reach. It opens NO
// write role, INSERTs no quarantine_row, and enqueues no 6e: a dry run in
// the strongest sense the domain allows. Duplicate detection is
// DELIBERATELY not projected (same omission previewBankFile makes): a
// duplicate is decided by the real Idempotency-Key-derived correlationId,
// which does not exist until commit.
export interface DamagePreviewRowResult {
  rowNo: number
  valid: boolean
  reasonCode?: 'no_match' | 'ambiguous_match' | 'invalid_damage_reason' | 'ambiguous_damage_reason'
  row: BankDamageRow
}

export interface DamagePreviewResult {
  rows: DamagePreviewRowResult[]
  summary: { total: number; valid: number; invalid: number }
  structuralErrors: StructuralParseError[]
}

export async function previewDamageFile(db: TmsDb, fileBytes: Uint8Array, filename: string): Promise<DamagePreviewResult> {
  const parsed = await parseBankDamageFile(fileBytes, filename, 'preview')
  if (parsed.errors.length > 0) {
    return { rows: [], summary: { total: 0, valid: 0, invalid: 0 }, structuralErrors: parsed.errors }
  }
  const rows = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_ops_read')
    const out: DamagePreviewRowResult[] = []
    for (const row of parsed.rows) {
      const matches = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM assignment
        WHERE bank_reference_code = ${row.tenantReference} AND vpa_value = ${row.vpaValue} AND replacement_of IS NULL
      `
      if (matches.length !== 1) {
        out.push({ rowNo: row.rowNo, valid: false, reasonCode: matches.length === 0 ? 'no_match' : 'ambiguous_match', row })
        continue
      }
      const reasonMatches = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM damage_reason
        WHERE active = true AND LOWER(TRIM(label)) = LOWER(TRIM(${row.damageReason}))
      `
      if (reasonMatches.length !== 1) {
        out.push({
          rowNo: row.rowNo,
          valid: false,
          reasonCode: reasonMatches.length === 0 ? 'invalid_damage_reason' : 'ambiguous_damage_reason',
          row,
        })
        continue
      }
      out.push({ rowNo: row.rowNo, valid: true, row })
    }
    return out
  })
  const valid = rows.reduce((n, r) => n + (r.valid ? 1 : 0), 0)
  return { rows, summary: { total: rows.length, valid, invalid: rows.length - valid }, structuralErrors: [] }
}

// Phase 2 Task 2 (D-K): the damage-file COMMIT. Same server-side re-parse and
// server-owned fileId rule as commitBankFile; there is no separate damage
// preview in v1 (damage validation is a DB match by tenant+vpa, which a pure
// preview cannot do; a later task may add one). Runs the UNCHANGED damage
// ingest (match + non-billable replacement + linkage/demand facts) under
// tms_write, keeping the partial-accept and the co-committed ALLOW 6e.
export async function commitDamageFile(
  db: TmsDb,
  args: { fileBytes: Uint8Array; filename: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ replaced: number; quarantined: number; duplicate: number; fileId: string }> {
  const fileId = args.clientKey
  const parsed = await parseBankDamageFile(args.fileBytes, args.filename, fileId)
  if (parsed.errors.length > 0) throw new BankFileParseError(parsed.errors)

  const tally = { replaced: 0, quarantined: 0, duplicate: 0 }
  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:upload-damage-file'), async () => {
      for (const row of parsed.rows) {
        const outcome = await ingestDamageRowWithinTx(tx, row, args.traceId)
        tally[outcome] += 1
      }
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the ingest.
      await enqueue(
        tx,
        buildAuthzAuditEvent(
          opsAllow({
            operation: 'ops:upload-damage-file',
            principalId: args.actorId,
            resourceIds: [],
            traceId: args.traceId,
          }),
        ),
      )
    })
  })
  return { ...tally, fileId }
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
export async function resolveQuarantineRow(
  db: TmsDb,
  args: { quarantineId: string; correctedRow: BankRequestRow; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; outcome: 'accepted' | 'quarantined' | 'duplicate' | null }> {
  let outcome: 'accepted' | 'quarantined' | 'duplicate' | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:resolve-quarantine'), async () => {
      outcome = await ingestRequestRowWithinTx(tx, args.correctedRow, args.traceId)
      await tx.$executeRaw`
        UPDATE quarantine_row
        SET resolved_at = now(), resolved_by_actor = ${args.actorId}::uuid
        WHERE id = ${args.quarantineId}::uuid AND resolved_at IS NULL
      `
      // Co-commit the ALLOW 6e (spec 10c CC-1) in the SAME tx as the re-ingest
      // and the resolved-at stamp. The quarantine row is the target resource.
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
  return { deduped: !ran, outcome }
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
// any LATER damage-file row still using its label quarantines
// (invalid_damage_reason, damage.ts) instead of creating a replacement, even
// though the label string itself is unchanged; only rows already replaced
// before deactivation are unaffected (this never touches assignment).
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
  args: { asgnId: string; newStatus: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  const target = CASE_STATUS_VALUES.find((v) => v === args.newStatus)
  if (target === undefined) {
    throw new OpsClientError('invalid', `case_status must be one of: ${CASE_STATUS_VALUES.join(', ')}`)
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
      await tx.$executeRaw`UPDATE assignment SET case_status = ${target}, updated_at = now() WHERE id = ${asgnUuid}::uuid`
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
