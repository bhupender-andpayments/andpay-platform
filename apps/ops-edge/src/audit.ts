import { emitVendorAuthzAudit } from '@andpay/fulfillment-service'
import type { FulfillmentDb } from '@andpay/fulfillment-service'

// The ops edge's authn-DENY 6e emission (Part A: DENY only, the per-action
// ALLOW/DENY 6e entries arrive with the Part-B controllers).
//
// It REUSES the existing emitVendorAuthzAudit unchanged: that helper takes an
// arbitrary AuthzAuditRecord (it does not hardcode cls:6 or any vendor field),
// enqueues buildAuthzAuditEvent into fulfillment's authz.audit outbox in its
// OWN short transaction (E1), and the existing consumer drains it. So a
// class-3 human-direct record rides the identical path with ZERO new consumer
// wiring, exactly mirroring the tenant edge's emitTenantAuthnDeny.
//
// IDs and enums only (S7/S10.5): principalId is 'unknown' because no
// credential ever resolved, resourceIds is empty, and the presented token is
// never read here, let alone logged or placed in the record (S4/5c).
export async function emitOpsAuthnDeny(
  fulfillmentDb: FulfillmentDb,
  args: { traceId: string; reasonCode: string },
): Promise<void> {
  await emitVendorAuthzAudit(fulfillmentDb, {
    principalId: 'unknown',
    cls: 3,
    operation: 'authenticate',
    decision: 'DENY',
    outcome: 'denied',
    reasonCode: args.reasonCode,
    actorChannel: 'human-direct',
    resourceIds: [],
    traceId: args.traceId,
  })
}
