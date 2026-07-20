import { randomUUID } from 'node:crypto'
import { enqueue, type OutboxTx } from '@andpay/outbox'
import type { PrincipalClass, Acr } from '@andpay/authz'
import type { AuthDb } from './db.js'

// The auth-INTERNAL audit event type (interpretive choice F): the 6e store is
// compliance-grade and single-consumer, so it rides the outbox to the auth-owned
// audit sink, NEVER the broadcast fact bus. Only fct.auth.credential.v1 is a
// public topic.
export const AUTHZ_AUDIT_EVENT = 'authz.audit'

// The 6e record shape: IDs and enums only, never PII, secrets, or bodies
// (S7/S10.5). The api_ id and display fingerprint may appear; the secret never
// does (the 5c redaction is upstream of the first write).
export interface AuthzAuditRecord {
  principalId: string
  cls: PrincipalClass
  operation: string
  decision: 'ALLOW' | 'DENY'
  outcome: string
  resourceIds?: string[]
  reasonCode?: string
  acr?: Acr
  authTime?: number
  asserterSvid?: string
  traceId: string
}

// Emit an audit record to the outbox INSIDE the caller's transaction (E1),
// committed with the operation, for at-least-once delivery to the audit sink by
// a deferred idempotent consumer (E6). The tamper-evident hash-chain/WORM store
// and the integrity job are DEFERRED; the emission path and record shape are
// built now.
export async function emitAuthzAudit(tx: OutboxTx, record: AuthzAuditRecord): Promise<void> {
  await enqueue(tx, {
    aggregateType: 'authz_audit',
    aggregateId: record.principalId,
    eventType: AUTHZ_AUDIT_EVENT,
    partitionKey: record.principalId,
    payload: { id: randomUUID(), ...record },
  })
}

// For a pure DENY or a hot-path allow that writes no business state, open a
// short transaction to carry the audit emission (the 6e async-flushed buffer
// tier). State-changing operations instead pass their own tx to emitAuthzAudit
// so the audit commits atomically with the operation.
export async function auditStandalone(db: AuthDb, record: AuthzAuditRecord): Promise<void> {
  await db.$transaction(async (tx) => {
    await emitAuthzAudit(tx, record)
  })
}
