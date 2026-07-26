import { computeEntryHash, GENESIS_PREV_HASH, type AuthzAuditRecord } from '@andpay/audit'
import type { AuthDb } from './db.js'

interface ChainRow {
  seq: bigint
  principal_id: string
  cls: number
  operation: string
  decision: string
  resource_ids: string[]
  outcome: string
  reason_code: string | null
  acr: string | null
  auth_time: bigint | null
  asserter_svid: string | null
  actor_channel: string | null
  trace_id: string
  prev_hash: string
  entry_hash: string
}

/**
 * Verify the authz_audit tamper-evident hash-chain end to end (6e, S15, D121).
 * Reads every row in seq order, reconstructs the exact AuthzAuditRecord each
 * entry_hash was computed over, and recomputes computeEntryHash(prev_hash,
 * seq, record) to require it equals the stored entry_hash, AND that
 * prev_hash equals the previous row's entry_hash (the lowest-seq row must
 * chain from GENESIS_PREV_HASH). Returns the seq of the FIRST break found, or
 * ok:true with the chain length (no genesis row is stored; an empty table is
 * a valid, trivially ok, zero-length chain).
 */
export async function verifyAuthzChain(db: AuthDb): Promise<{ ok: boolean; brokenAtSeq?: number; length: number }> {
  const rows = await db.$queryRaw<ChainRow[]>`
    SELECT seq, principal_id, cls, operation, decision, resource_ids, outcome,
           reason_code, acr, extract(epoch from auth_time)::bigint AS auth_time,
           asserter_svid, actor_channel, trace_id, prev_hash, entry_hash
    FROM authz_audit
    ORDER BY seq ASC
  `

  let expectedPrev = GENESIS_PREV_HASH
  for (const row of rows) {
    const seq = Number(row.seq)
    const record: AuthzAuditRecord = {
      principalId: row.principal_id,
      cls: row.cls as AuthzAuditRecord['cls'],
      operation: row.operation,
      decision: row.decision as AuthzAuditRecord['decision'],
      outcome: row.outcome,
      resourceIds: row.resource_ids,
      reasonCode: row.reason_code ?? undefined,
      acr: (row.acr ?? undefined) as AuthzAuditRecord['acr'],
      authTime: row.auth_time === null ? undefined : Number(row.auth_time),
      asserterSvid: row.asserter_svid ?? undefined,
      actorChannel: (row.actor_channel ?? undefined) as AuthzAuditRecord['actorChannel'],
      traceId: row.trace_id,
    }
    const recomputed = computeEntryHash(row.prev_hash, seq, record)
    if (row.prev_hash !== expectedPrev || recomputed !== row.entry_hash) {
      return { ok: false, brokenAtSeq: seq, length: rows.length }
    }
    expectedPrev = row.entry_hash
  }
  return { ok: true, length: rows.length }
}
