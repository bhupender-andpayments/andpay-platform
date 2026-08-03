import { randomUUID } from 'node:crypto'
import { type CanActivate, type ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common'
import { resolveClaimFromAuthHeader, EdgeAuthError } from '@andpay/edge'
import { AuthzError, type LeanClaim } from '@andpay/authz'
import { auditStandalone, INTERNAL_ADMIN_PLANE } from '@andpay/auth-service'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'

interface RequestWithClaim {
  headers: Record<string, string | undefined>
  claim?: LeanClaim
  traceId?: string
}

// The pepper is required by resolveClaimFromAuthHeader's type but is only
// read on the apsk_ branch (it peppers the HMAC before the local lookup).
// This edge wires no credential projection (lookup below always returns
// undefined), so a stray apsk_ fails closed at the lookup regardless of the
// pepper value; the JWT branch never touches it. Mirrors
// apps/auth-edge/src/admin.guard.ts's UNUSED_PEPPER exactly.
const UNUSED_PEPPER = 'vendor-auth-edge-jwt-path-pepper-unused'

// The admin-seed provisioning/enroll routes' authentication gate (spec 14a
// task 11, check 3). It verifies the presented Decision-3 access token
// LOCALLY against this edge's own JWKS. The Fork D multi-key signer wired
// into `deps.jwks` (Task 2/8) publishes BOTH the internal-admin and vendor
// public keys, so an internal class-3 token, minted by apps/auth-edge (a
// DIFFERENT process, same keyset per Task 2's deploy-time contract; see
// deps.ts's scaffold-limitation comment for the local-dev caveat), verifies
// here with ZERO call to Auth on the request path (T4/S14/5e).
//
// The verifier pins BOTH the audience (`andpay:internal-admin`, so a
// class-7 vendor token minted for `andpay:vendor` is rejected outright) AND
// the mode (a token whose mode claim differs from this edge's is rejected),
// each read from the CLAIM, never a request body (M7/S16).
//
// Defense-in-depth: even a validly-signed internal-admin token whose class
// is not 3 is rejected (covers cls 1/2/4/5 on a keyset misconfiguration).
// Any failure, for any reason, is fail-closed: no claim is attached and the
// request is rejected with a GENERIC 401 (UnauthorizedException with no
// argument). The presented token is NEVER logged or placed in the thrown
// response (S4/5c); the app is built logger:false.
//
// Mirrors apps/auth-edge/src/admin.guard.ts's DENY-on-every-rejection
// discipline: a synchronous authn-DENY 6e is committed (auditStandalone,
// its OWN auth_write tx, awaited to durable commit) BEFORE the 401 is
// observable to the caller. Not a best-effort swallow: a commit failure
// PROPAGATES (fail-closed).
@Injectable()
export class VendorAuthEdgeAdminGuard implements CanActivate {
  constructor(@Inject(EDGE_DEPS) private readonly deps: VendorAuthEdgeDeps) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithClaim>()
    const authHeader = req.headers['authorization']
    const traceId = randomUUID()

    try {
      const claim = await resolveClaimFromAuthHeader(authHeader, {
        pepper: UNUSED_PEPPER,
        lookup: () => undefined,
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
        expectedPlane: INTERNAL_ADMIN_PLANE,
        expectedMode: this.deps.expectedMode,
      })
      // This is a class-3-only admin route; reject any other class even on a
      // validly-signed internal-admin token, including class 7 (a vendor
      // token can never carry the internal-admin audience anyway, but this
      // is defense-in-depth against a keyset/plane drift).
      if (claim.cls !== 3) throw new EdgeAuthError('class-not-admin')
      req.claim = claim
      req.traceId = traceId
      return true
    } catch (err) {
      const reasonCode = err instanceof EdgeAuthError || err instanceof AuthzError ? err.code : 'authn-error'
      await auditStandalone(this.deps.authDb, {
        principalId: 'unknown',
        cls: 3,
        operation: 'authenticate',
        decision: 'DENY',
        resourceIds: [],
        outcome: 'denied',
        reasonCode,
        traceId,
      })
      throw new UnauthorizedException()
    }
  }
}
