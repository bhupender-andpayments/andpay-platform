import { emitVendorAuthzAudit } from '@andpay/fulfillment-service'
import type { FulfillmentDb } from '@andpay/fulfillment-service'
import {
  emitAnalyticsReadAudit,
  emitAnalyticsCrossTenantAccess,
  type AnalyticsDb,
} from '@andpay/analytics-service'
import type { Acr } from '@andpay/authz'

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

// The ops edge's per-action 6e authz-audit emission (Part B): ONE record per
// action decision. It REUSES the same emitVendorAuthzAudit path as the
// authn-DENY above (a record-generic helper that enqueues into fulfillment's
// authz.audit outbox in its OWN short transaction, E1, so the existing consumer
// drains it with ZERO new wiring), with cls:3 and actorChannel:'human-direct'
// baked in for the class-3 human ops plane (D-3).
//
// IDs-and-enums only (S7/S10.5): `principalId` is the claim subject (D99, from
// the verified claim, never a body), `resourceIds` is the TARGET ids only (path
// or body wire ids), and NEVER any PII, request body, or free text. A terminal
// override's free-text reason lives ONLY on the shpt_status_event.override_reason
// domain row (DD1), never here; the ALLOW record for it carries the enum
// reasonCode 'terminal-override' plus the step-up assurance (acr, auth_time)
// that authorized the C3 bypass, nothing more.
export async function emitOpsAuthzAudit(
  fulfillmentDb: FulfillmentDb,
  args: {
    principalId: string
    operation: string
    decision: 'ALLOW' | 'DENY'
    outcome: string
    reasonCode?: string
    acr?: Acr
    authTime?: number
    resourceIds: string[]
    traceId: string
  },
): Promise<void> {
  await emitVendorAuthzAudit(fulfillmentDb, {
    principalId: args.principalId,
    cls: 3,
    operation: args.operation,
    decision: args.decision,
    outcome: args.outcome,
    reasonCode: args.reasonCode,
    acr: args.acr,
    authTime: args.authTime,
    actorChannel: 'human-direct',
    resourceIds: args.resourceIds,
    traceId: args.traceId,
  })
}

// The ops edge's per-read-decision 6e for the ANALYTICS reporting routes (spec
// 11 task 8, ADDITIVE). It delegates to the analytics context's own
// emitAnalyticsReadAudit, which enqueues into the ANALYTICS outbox (analytics
// enters analytics_write in its own short transaction), NOT the fulfillment
// authz.audit outbox the ops-action helper above uses. Every class-3 analytics
// read decision stays on the analytics rail (C4). IDs-and-enums only
// (S7/S10.5): principalId is the claim subject (D99), cls is 3, and NO report
// row, PII, or token bytes ever ride the record.
export async function emitOpsAnalyticsRead(
  analyticsDb: AnalyticsDb,
  args: {
    principalId: string
    operation: string
    decision: 'ALLOW' | 'DENY'
    resourceIds: string[]
    traceId: string
    reasonCode?: string
  },
): Promise<void> {
  await emitAnalyticsReadAudit(analyticsDb, {
    principalId: args.principalId,
    cls: 3,
    operation: args.operation,
    decision: args.decision,
    resourceIds: args.resourceIds,
    traceId: args.traceId,
    reasonCode: args.reasonCode,
  })
}

// The D99 cross-tenant-access entry (guardrail G3, Q5): a SECOND, DISTINCT 6e
// record logged IN ADDITION to the per-read 6e above whenever the class-3 ops
// reporting plane reads across tenant boundaries (which, by construction, it
// always does: it builds a { kind: 'crossTenant' } ReadScope). Delegates to the
// analytics context's emitAnalyticsCrossTenantAccess, on the analytics outbox.
export async function emitOpsAnalyticsCrossTenant(
  analyticsDb: AnalyticsDb,
  args: { principalId: string; operation: string; traceId: string },
): Promise<void> {
  await emitAnalyticsCrossTenantAccess(analyticsDb, {
    principalId: args.principalId,
    operation: args.operation,
    traceId: args.traceId,
  })
}
