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
