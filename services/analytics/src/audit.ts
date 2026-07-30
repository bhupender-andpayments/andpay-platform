import { enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import type { AnalyticsDb } from './db.js'
import { enterWriteRole } from './write-context.js'

// The analytics-context 6e read-decision emit (S19, spec 11 task 7). Mirrors
// the fulfillment context's emitVendorAuthzAudit (vendor-audit.ts) exactly, on
// analytics_write and analytics.outbox: the role is entered FIRST, inside its
// own transaction, before the enqueue (the 10d landmine: otherwise the
// enqueue runs as the table owner, bypassing the role boundary). IDs and
// enums only (S7/S10.5): principalId, cls, operation, decision, resourceIds,
// traceId, optional reasonCode. Never a report row, never PII, never a
// secret.
export async function emitAnalyticsReadAudit(
  db: AnalyticsDb,
  args: {
    principalId: string
    cls: 2 | 3
    operation: string
    decision: 'ALLOW' | 'DENY'
    resourceIds: string[]
    traceId: string
    reasonCode?: string
  },
): Promise<void> {
  const record: AuthzAuditRecord = {
    principalId: args.principalId,
    cls: args.cls,
    operation: args.operation,
    decision: args.decision,
    outcome: args.decision === 'ALLOW' ? 'allowed' : 'denied',
    reasonCode: args.reasonCode,
    actorChannel: 'human-direct',
    resourceIds: args.resourceIds,
    traceId: args.traceId,
  }
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'analytics_write')
    await enqueue(tx, buildAuthzAuditEvent(record))
  })
}

// The D99 cross-tenant-access entry (guardrail G3, Q5): a SECOND, DISTINCT 6e
// record logged IN ADDITION to the per-read audit above whenever a read
// spans more than one tenant's data. resourceIds is empty by design: the
// cross-tenant marker records the ATTEMPT (principal, operation, trace), not
// the specific resources touched, which the per-read 6e already carries.
export async function emitAnalyticsCrossTenantAccess(
  db: AnalyticsDb,
  args: { principalId: string; operation: string; traceId: string },
): Promise<void> {
  const record: AuthzAuditRecord = {
    principalId: args.principalId,
    cls: 3,
    operation: 'analytics:cross-tenant-read',
    decision: 'ALLOW',
    outcome: 'allowed',
    actorChannel: 'human-direct',
    resourceIds: [],
    traceId: args.traceId,
  }
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'analytics_write')
    await enqueue(tx, buildAuthzAuditEvent(record))
  })
}
