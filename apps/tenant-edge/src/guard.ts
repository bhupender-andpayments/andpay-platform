import { randomUUID } from 'node:crypto'
import { type CanActivate, type ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common'
import { resolveClaimFromAuthHeader, EdgeAuthError } from '@andpay/edge'
import { AuthzError, type LeanClaim } from '@andpay/authz'
import { EDGE_DEPS, type TenantEdgeDeps } from './deps.js'
import { emitTenantAuthnDeny } from './audit.js'

interface RequestWithClaim {
  headers: Record<string, string | undefined>
  claim?: LeanClaim
  traceId?: string
}

// The pepper is required by resolveClaimFromAuthHeader's type but is only read
// on the apsk_ branch (it peppers the HMAC before the local lookup). This edge
// wires no credential projection (lookup below always returns undefined), so a
// stray apsk_ fails closed at the lookup regardless of the pepper value; the
// JWT branch never touches it. A fixed non-secret placeholder is therefore
// correct and carries no S4 risk: no real credential can ever be minted or
// matched against it.
const UNUSED_PEPPER = 'tenant-edge-jwt-path-pepper-unused'

// The tenant edge's ONLY authentication gate (checks 1/4): verifies the
// presented Decision-3 access token LOCALLY against the injected JWKS, with
// ZERO call to Auth on the request path (T4/S14/5e). The verifier gates BOTH
// the audience (pinned to the tenant-portal plane, so a token minted for any
// other plane is rejected) AND the mode (a token whose mode claim differs from
// the edge's own is rejected), each read from the CLAIM, never a request body
// (M7/S16). An apsk_ credential (class 6) fails closed: no projection is wired
// here, so the local lookup finds nothing. Any failure, for any reason, is
// fail-closed: no claim is ever attached, an authn-DENY authz-audit record is
// emitted (IDs only, principalId 'unknown' since no credential resolved, the
// failure's error code as reasonCode), and the request is rejected 401. The
// presented token is NEVER logged or placed in the thrown response (S4, 5c):
// UnauthorizedException() is constructed with no argument, so the body is the
// generic framework 401.
@Injectable()
export class TenantEdgeGuard implements CanActivate {
  constructor(@Inject(EDGE_DEPS) private readonly deps: TenantEdgeDeps) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithClaim>()
    const authHeader = req.headers['authorization']
    const traceId = randomUUID()

    try {
      // The lookup fails closed for any apsk_ credential: the tenant edge wires
      // no credential projection, so a class-6 secret can never resolve here
      // (105f: class 6 is a machine plane, never the human tenant portal).
      const claim = await resolveClaimFromAuthHeader(authHeader, {
        pepper: UNUSED_PEPPER,
        lookup: () => undefined,
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
        expectedPlane: 'andpay:tenant-portal',
        expectedMode: this.deps.expectedMode,
      })
      // Defense-in-depth (this class-2-only edge): reject any claim whose
      // class is not 2, even a validly-signed tenant-portal-aud token, in
      // case of issuer-side plane/class drift. Class 6 is already rejected
      // upstream (class6-jwt-rejected); this covers cls 1/3/4/5.
      if (claim.cls !== 2) throw new EdgeAuthError('class-not-tenant')
      req.claim = claim
      // Propagate the guard-minted traceId to the controller so its per-read
      // 6e authz-audit record correlates with this same authenticated request.
      req.traceId = traceId
      return true
    } catch (err) {
      // The reasonCode exactly mirrors the code the edge/authz layer threw
      // (missing-credential, malformed-authorization, token-verify-failed,
      // mode-mismatch, credential-unknown, ...). It carries no token bytes.
      const reasonCode = err instanceof EdgeAuthError || err instanceof AuthzError ? err.code : 'authn-error'
      try {
        // Best-effort audit: a transient outbox/DB failure here must never
        // turn a 401 into a 500, and must never drop the fail-closed
        // guarantee below. The error itself is not logged (redaction, S4/5c).
        await emitTenantAuthnDeny(this.deps.fulfillmentDb, { traceId, reasonCode })
      } catch {
        // swallowed: see comment above.
      }
      throw new UnauthorizedException()
    }
  }
}
