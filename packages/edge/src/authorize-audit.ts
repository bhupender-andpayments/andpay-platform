import { authorize, type AuthzResource, type AuthzDecision, type RoleConfig, type LeanClaim } from '@andpay/authz'
import type { AuthzAuditRecord } from '@andpay/audit'

export interface AuditDeps {
  cfg: RoleConfig
  emit: (record: AuthzAuditRecord) => Promise<void>
  traceId: string
}

// Run the Decision-2 two-gate authorize LOCALLY (permission AND scope, both
// ANDed), then emit an IDs-only 6e authz-audit record (S10.5/S7: no secret,
// no PII, ever). The record carries only the already-resolved principal id
// and class from the claim and the already-scoped resource ids; nothing
// else is read from the request.
export async function authorizeAndAudit(
  deps: AuditDeps,
  claim: LeanClaim,
  operation: string,
  resource: AuthzResource,
): Promise<AuthzDecision> {
  const decision = authorize(claim, operation, resource, deps.cfg)

  const record: AuthzAuditRecord = {
    principalId: claim.sub,
    cls: claim.cls,
    operation,
    decision: decision.allowed ? 'ALLOW' : 'DENY',
    outcome: decision.allowed ? 'authorized' : 'denied',
    reasonCode: decision.reason,
    resourceIds: [resource.vndrId, resource.workQueue].filter((x): x is string => typeof x === 'string'),
    actorChannel: 'vendor-edge',
    traceId: deps.traceId,
  }

  await deps.emit(record)
  return decision
}
