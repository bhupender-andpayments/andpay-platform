import type { LeanClaim } from '@andpay/authz'

// The shape EdgeCredentialGuard attaches to the request object: `req.claim`,
// the resolved class-6 LeanClaim. Every controller behind the guard reads it.
export interface EdgeRequest {
  claim: LeanClaim
}
