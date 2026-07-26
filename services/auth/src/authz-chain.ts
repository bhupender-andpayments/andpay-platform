import { randomUUID } from 'node:crypto'
import { onceWithin, type OutboxTx } from '@andpay/outbox'
import { computeEntryHash, GENESIS_PREV_HASH, type AuthzAuditRecord } from '@andpay/audit'

// The inbox consumer identity for the appender's E6 dedup (6e). Keyed on the
// EVENT id (eventId), never the record content, so a redelivery of the same
// outbox event is a no-op, while two genuinely distinct events that happen to
// carry identical record content both append.
export const AUTHZ_AUDIT_CONSUMER = 'auth.authz-audit-appender'

// A fixed advisory-lock key that serializes every append against the WHOLE
// table (S15), not just the current head row. A row-level lock (e.g.
// SELECT ... FOR UPDATE on the head) has nothing to lock when the table is
// empty or between the head row and a concurrent inserter's not-yet-committed
// row, so two overlapping appenders could both read "no head" and both
// compute seq=1. The transaction-scoped advisory lock closes that gap: it is
// acquired BEFORE the head read and held until the transaction commits or
// rolls back, so the head-read-then-insert sequence is atomic across every
// concurrent appender, with or without existing rows.
const CHAIN_LOCK_KEY = 8471104

// appendAuthzAudit's public parameter is OutboxTx (matching @andpay/outbox's
// own contract), but the head-read needs $queryRaw alongside OutboxTx's
// $executeRaw. Every interactive Prisma transaction client the caller passes
// in satisfies both structurally, the same widening @andpay/outbox's own
// OutboxRelayTx applies for the relay.
interface ChainTx extends OutboxTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
}

interface HeadRow {
  seq: bigint
  entry_hash: string
}

/**
 * Append one record to the tamper-evident authz_audit hash-chain (6e, S15, D121),
 * inside the caller's transaction. E6 dedup on the EVENT id: a redelivery of
 * `eventId` is a no-op and returns { appended: false }. Concurrency safety: a
 * fixed-key transaction-scoped advisory lock (pg_advisory_xact_lock) is taken
 * BEFORE the head read, serializing the read-seq-then-insert sequence across
 * every concurrent appender (no separate max(seq); the same lock that guards
 * the read also guards the write, so there is no TOCTOU window and no forked
 * chain).
 */
export async function appendAuthzAudit(
  tx: OutboxTx,
  record: AuthzAuditRecord,
  eventId: string,
): Promise<{ appended: boolean; seq?: number }> {
  let seq: number | undefined
  const appended = await onceWithin(tx, AUTHZ_AUDIT_CONSUMER, eventId, async () => {
    const chainTx = tx as ChainTx
    // Serialize against every other appender, even on an empty table.
    await chainTx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`

    const head = await chainTx.$queryRaw<HeadRow[]>`
      SELECT seq, entry_hash FROM authz_audit ORDER BY seq DESC LIMIT 1
    `
    const prev = head.length === 0 ? GENESIS_PREV_HASH : head[0]!.entry_hash
    seq = head.length === 0 ? 1 : Number(head[0]!.seq) + 1
    const entryHash = computeEntryHash(prev, seq, record)
    const id = randomUUID()
    const resourceIds = record.resourceIds ?? []

    await chainTx.$executeRaw`
      INSERT INTO authz_audit (
        id, principal_id, cls, operation, decision, resource_ids, outcome,
        reason_code, acr, auth_time, asserter_svid, actor_channel, trace_id,
        created_at, seq, prev_hash, entry_hash
      ) VALUES (
        ${id}::uuid, ${record.principalId}, ${record.cls}, ${record.operation}, ${record.decision},
        ${resourceIds}, ${record.outcome},
        ${record.reasonCode ?? null}, ${record.acr ?? null},
        to_timestamp(${record.authTime ?? null}),
        ${record.asserterSvid ?? null}, ${record.actorChannel ?? null}, ${record.traceId},
        now(), ${seq}, ${prev}, ${entryHash}
      )
    `
  })
  return appended ? { appended: true, seq } : { appended: false }
}
