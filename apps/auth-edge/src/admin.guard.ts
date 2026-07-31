import { randomUUID } from 'node:crypto'
import { type CanActivate, type ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common'
import { resolveClaimFromAuthHeader, EdgeAuthError } from '@andpay/edge'
import { type LeanClaim } from '@andpay/authz'
import { EDGE_DEPS, type AuthEdgeDeps } from './deps.js'

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
// matched against it. Mirrors the ops/tenant edge's UNUSED_PEPPER exactly.
const UNUSED_PEPPER = 'auth-edge-jwt-path-pepper-unused'

// The enroll route's authentication gate (spec 12 task 11, check 3). It
// verifies the presented Decision-3 access token LOCALLY against this edge's
// own JWKS (the SAME keyset it minted the token with; auth-edge is both the
// token producer and, on this guarded route, its own verifier), with ZERO call
// to Auth on the request path (T4/S14/5e). The verifier pins BOTH the audience
// (the internal-admin plane, so a token minted for any other plane is
// rejected) AND the mode (a token whose mode claim differs from this edge's is
// rejected), each read from the CLAIM, never a request body (M7/S16). An apsk_
// credential (class 6) fails closed: no projection is wired here, so the local
// lookup finds nothing.
//
// Defense-in-depth: even a validly-signed internal-admin token whose class is
// not 3 is rejected, in case of issuer-side plane/class drift. Any failure,
// for any reason, is fail-closed: no claim is attached and the request is
// rejected with a GENERIC 401 (UnauthorizedException with no argument, so the
// body is the framework default). The presented token is NEVER logged or
// placed in the thrown response (S4/5c). The app is built logger:false, so no
// request line, header, or token can reach a log sink.
//
// Unlike the ops edge, this guard emits NO authn-DENY 6e: auth-edge wires no
// authz-audit outbox on the request path (it is the token producer, not a
// fulfillment/analytics consumer), and the enroll ALLOW 6e is co-committed
// inside enrollTotp's own transaction (check 4). D3 denylist is deferred here
// exactly as at the ops/tenant edges (no denylist option is wired below).
@Injectable()
export class AuthEdgeAdminGuard implements CanActivate {
  constructor(@Inject(EDGE_DEPS) private readonly deps: AuthEdgeDeps) {}

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
        expectedPlane: 'andpay:internal-admin',
        expectedMode: this.deps.expectedMode,
      })
      // This is a class-3-only edge route; reject any other class even on a
      // validly-signed internal-admin token. Class 6 is already rejected
      // upstream by resolveClaimFromAuthHeader; this covers cls 1/2/4/5.
      if (claim.cls !== 3) throw new EdgeAuthError('class-not-admin')
      req.claim = claim
      // Propagate the guard-minted traceId so the enroll op's co-committed 6e
      // audit correlates with this same authenticated request.
      req.traceId = traceId
      return true
    } catch {
      throw new UnauthorizedException()
    }
  }
}
