import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import type { TmsDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { ingestRequestRowWithinTx, type BankRequestRow } from './ingest.js'
import { ingestDamageRowWithinTx, type BankDamageRow } from './damage.js'

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

export async function uploadBankFile(
  db: TmsDb,
  args: { rows: BankRequestRow[]; clientKey: string; actorId: string; traceId: string },
): Promise<{ accepted: number; quarantined: number; duplicate: number }> {
  const tally = { accepted: 0, quarantined: 0, duplicate: 0 }
  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:upload-bank-file'), async () => {
      for (const row of args.rows) {
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
  return tally
}

export async function uploadDamageFile(
  db: TmsDb,
  args: { rows: BankDamageRow[]; clientKey: string; actorId: string; traceId: string },
): Promise<{ replaced: number; quarantined: number; duplicate: number }> {
  const tally = { replaced: 0, quarantined: 0, duplicate: 0 }
  await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE tms_write')
    await onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:upload-damage-file'), async () => {
      for (const row of args.rows) {
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
  return tally
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
