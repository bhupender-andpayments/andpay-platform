import type { LeanClaim } from '@andpay/authz'

// The shape TenantEdgeGuard attaches to the request object: `req.claim`, the
// resolved class-2 LeanClaim, and `req.traceId`, the guard-minted correlation
// id. Every controller behind the guard reads the claim (D99: scope is
// re-derived from the claim ONLY, never a request field) and propagates the
// SAME traceId into its per-read 6e authz-audit record.
export interface EdgeRequest {
  claim: LeanClaim
  traceId: string
}
