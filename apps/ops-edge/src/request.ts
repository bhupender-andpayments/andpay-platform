import type { LeanClaim } from '@andpay/authz'

// The shape OpsEdgeGuard attaches to the request object: `req.claim`, the
// resolved class-3 LeanClaim, and `req.traceId`, the guard-minted correlation
// id. Every controller behind the guard reads the claim (D99: scope/actor is
// re-derived from the claim ONLY, never a request field) and propagates the
// SAME traceId into its per-action 6e authz-audit record (Part B).
export interface EdgeRequest {
  claim: LeanClaim
  traceId: string
}
