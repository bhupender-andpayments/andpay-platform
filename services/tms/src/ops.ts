import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import { toUuid } from '@andpay/ids'
import type { TmsDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole, enterWriteScope } from './write-context.js'
import {
  ingestRequestRowWithinTx,
  requestRowRejectReason,
  type BankRequestRow,
  type RequestRowRejectReason,
} from './ingest.js'
import { ingestDamageRowWithinTx, CASE_STATUS_VALUES } from './damage.js'
import {
  parseBankRequestFile,
  parseBankDamageFile,
  type StructuralParseError,
} from './bank-file-adapter.js'
import { createDamageReasonWithinTx, setDamageReasonActiveWithinTx, type DamageReasonRow } from './damage-reason.js'

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
): Promise<{ accepted: number; quarantined: number; duplicate: number; fileId: string }> {
  const fileId = args.clientKey
  const parsed = await parseBankRequestFile(args.fileBytes, args.filename, fileId)
  if (parsed.errors.length > 0) throw new BankFileParseError(parsed.errors)

  const tally = { accepted: 0, quarantined: 0, duplicate: 0 }
  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:upload-bank-file'), async () => {
      for (const row of parsed.rows) {
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
  return { ...tally, fileId }
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
