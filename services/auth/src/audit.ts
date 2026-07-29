import { randomUUID } from 'node:crypto'
import { enqueue, type OutboxTx } from '@andpay/outbox'
import type { AuthzAuditRecord } from '@andpay/audit'
import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'

// The auth-INTERNAL audit event type (interpretive choice F): the 6e store is
// compliance-grade and single-consumer, so it rides the outbox to the auth-owned
// audit sink, NEVER the broadcast fact bus. Only fct.auth.credential.v1 is a
// public topic.
export const AUTHZ_AUDIT_EVENT = 'authz.audit'

// The 6e record shape now lives in @andpay/audit (task 1), shared verbatim
// with the tamper-evident hash-chain appender and integrity job
// (authz-chain.ts, authz-chain-verify.ts) so all three never drift from one
// definition. IDs and enums only, never PII, secrets, or bodies (S7/S10.5).
export type { AuthzAuditRecord } from '@andpay/audit'

// Emit an audit record to the outbox INSIDE the caller's transaction (E1),
// committed with the operation, for at-least-once delivery to the audit sink
// by an idempotent consumer (E6). appendAuthzAudit (authz-chain.ts) is that
// consumer: it chains the record into the tamper-evident hash-chain.
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
    // Spec 10d Task 6 completion pass: this tx opens its own outbox write
    // (emitAuthzAudit enqueues to auth.outbox) with no caller-supplied,
    // already-scoped tx to inherit a role from, so it must enter auth_write
    // itself, as the FIRST statement, mechanically identical to every other
    // retrofitted site.
    await enterWriteRole(tx, 'auth_write')
    await emitAuthzAudit(tx, record)
  })
}
