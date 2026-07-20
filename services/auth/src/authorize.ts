import { authorize, type LeanClaim, type RoleConfig, type AuthzDecision } from '@andpay/authz'
import type { AuthDb } from './db.js'
import { auditStandalone } from './audit.js'

export interface AuthorizeAuditedDeps {
  db: AuthDb
  cfg: RoleConfig
  traceId: string
}

// Run the D2 two-gate evaluation and emit a 6e audit on DENY (every DENY is
// audited, S15/6e). Routine ALLOWs are NOT audited here (that would bury signal
// in noise, 6e "NOT every read"); sensitive-operation ALLOWs are audited at
// their own call sites (login, credential issuance).
export async function authorizeAudited(
  claim: LeanClaim,
  operation: string,
  resource: { programId?: string; vndrId?: string; workQueue?: string },
  deps: AuthorizeAuditedDeps,
): Promise<AuthzDecision> {
  const decision = authorize(claim, operation, resource, deps.cfg)
  if (!decision.allowed) {
    await auditStandalone(deps.db, {
      principalId: claim.sub,
      cls: claim.cls,
      operation,
      decision: 'DENY',
      outcome: 'denied',
      reasonCode: decision.reason,
      acr: claim.acr,
      authTime: claim.auth_time,
      traceId: deps.traceId,
    })
  }
  return decision
}
