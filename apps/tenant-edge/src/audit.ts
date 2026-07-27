import { emitVendorAuthzAudit } from '@andpay/fulfillment-service'
import type { FulfillmentDb } from '@andpay/fulfillment-service'

// The tenant edge's authn-DENY 6e emission (this task: DENY only, the authz
// ALLOW/DENY for domain operations arrives with the Task-6 controllers).
//
// It REUSES the existing emitVendorAuthzAudit unchanged: that helper takes an
// arbitrary AuthzAuditRecord (it does not hardcode cls:6 or any vendor field),
// enqueues buildAuthzAuditEvent into fulfillment's authz.audit outbox in its
// OWN short transaction (E1), and the existing consumer drains it. So a class-2
// human-direct record rides the identical path with ZERO new consumer wiring.
// The helper's vendor-prefixed NAME is now a slight misnomer, but re-minting a
// generic sibling would duplicate the outbox path for no behavioral gain.
//
// IDs and enums only (S7/S10.5): principalId is 'unknown' because no credential
// ever resolved, resourceIds is empty, and the presented token is never read
// here, let alone logged or placed in the record (S4/5c).
export async function emitTenantAuthnDeny(
  fulfillmentDb: FulfillmentDb,
  args: { traceId: string; reasonCode: string },
): Promise<void> {
  await emitVendorAuthzAudit(fulfillmentDb, {
    principalId: 'unknown',
    cls: 2,
    operation: 'authenticate',
    decision: 'DENY',
    outcome: 'denied',
    reasonCode: args.reasonCode,
    actorChannel: 'human-direct',
    resourceIds: [],
    traceId: args.traceId,
  })
}

// The tenant edge's per-read-decision 6e emission (Task 6, D-7): ONE record per
// authz decision (per request), NEVER per row. It REUSES the same
// emitVendorAuthzAudit path as the authn-DENY above (a record-generic helper
// that enqueues into fulfillment's authz.audit outbox in its own short
// transaction, so the existing consumer drains it with ZERO new wiring).
//
// The record is IDs-and-enums only (S7/S10.5): principalId is the claim subject,
// resourceIds is [tenantId, ...programIds] (both re-derived from the verified
// claim, D99), and NO query result, ship-to PII, contact, or mobile ever rides
// this record. The tenant's own ship-to PII (Fork F) lives in the HTTP response
// body ONLY, never here and never a log (S4/5c). A falsy tenantId (an absent
// scope.tid) is dropped rather than emitted as an empty id.
export async function emitTenantReadAudit(
  fulfillmentDb: FulfillmentDb,
  args: {
    principalId: string
    operation: string
    decision: 'ALLOW' | 'DENY'
    tenantId: string | undefined
    programIds: string[]
    traceId: string
    reasonCode?: string
  },
): Promise<void> {
  const resourceIds = [args.tenantId, ...args.programIds].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  await emitVendorAuthzAudit(fulfillmentDb, {
    principalId: args.principalId,
    cls: 2,
    operation: args.operation,
    decision: args.decision,
    outcome: args.decision === 'ALLOW' ? 'allowed' : 'denied',
    reasonCode: args.reasonCode,
    actorChannel: 'human-direct',
    resourceIds,
    traceId: args.traceId,
  })
}
