import type { LeanClaim } from '@andpay/authz'

// The shape TenantEdgeGuard attaches to the request object: `req.claim`, the
// resolved class-2 LeanClaim. Every controller behind the guard reads it.
export interface EdgeRequest {
  claim: LeanClaim
}
