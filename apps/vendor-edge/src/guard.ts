import { randomUUID } from 'node:crypto'
import { type CanActivate, type ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common'
import { resolveClaimFromAuthHeader, EdgeAuthError } from '@andpay/edge'
import { AuthzError, type LeanClaim } from '@andpay/authz'
import { loadCredentialProjection, emitVendorAuthzAudit } from '@andpay/fulfillment-service'
import { EDGE_DEPS, type EdgeDeps } from './deps.js'

interface RequestWithClaim {
  headers: Record<string, string | undefined>
  claim?: LeanClaim
}

// The edge's ONLY authentication gate (checks 1/4): resolves the presented
// credential LOCALLY via @andpay/edge/@andpay/authz, zero call to Auth on the
// request path (T4/S14/5e). Any failure, for any reason, is fail-closed: no
// claim is ever attached, an authn-DENY authz-audit record is emitted (IDs
// only, the failure's error code as reasonCode, principalId 'unknown' since
// no credential ever resolved), and the request is rejected 401. The
// presented secret is NEVER logged or placed in the thrown response (S4, 5c).
@Injectable()
export class EdgeCredentialGuard implements CanActivate {
  constructor(@Inject(EDGE_DEPS) private readonly deps: EdgeDeps) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithClaim>()
    const authHeader = req.headers['authorization']
    const traceId = randomUUID()

    // Fail-fast (Minor review fix): a missing or malformed Authorization
    // header can never resolve to a claim regardless of what the
    // credential_projection contains, so reject BEFORE paying for its
    // full-table scan load. The reasonCode for each case exactly mirrors the
    // EdgeAuthError code resolveClaimFromAuthHeader would itself have thrown
    // ('missing-credential', 'malformed-authorization'), so the DENY audit
    // and the 401 outcome are unchanged from before this fast path existed.
    if (!authHeader) {
      await this.denyUnauthenticated(traceId, 'missing-credential')
      throw new UnauthorizedException()
    }
    if (!authHeader.startsWith('Bearer ')) {
      await this.denyUnauthenticated(traceId, 'malformed-authorization')
      throw new UnauthorizedException()
    }

    try {
      // Pre-load the whole projection into a Map once per request (the
      // async -> sync bridge resolveClaimFromAuthHeader needs, since its own
      // `lookup` must be synchronous), then pass a sync closure over it.
      const map = await loadCredentialProjection(this.deps.fulfillmentDb)
      const claim = await resolveClaimFromAuthHeader(authHeader, {
        pepper: this.deps.pepper,
        lookup: (pepperedHashHex: string) => map.get(pepperedHashHex),
        expectedPlane: 'andpay:vendor',
        expectedMode: this.deps.expectedMode,
        // Spec 14a task 13: wired only when the edge is configured for the
        // class-7 vendor-operator plane (both optional, mirrored from
        // ResolveDeps). Undefined on an edge that wires neither, so a
        // JWT-shaped credential fails closed exactly as before this task
        // (jwt-not-supported-on-this-edge); the apsk_ bearer branch never
        // reads either field (D6, class-6 byte-unchanged).
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
      })
      req.claim = claim
      return true
    } catch (err) {
      const reasonCode = err instanceof EdgeAuthError || err instanceof AuthzError ? err.code : 'authn-error'
      await this.denyUnauthenticated(traceId, reasonCode)
      throw new UnauthorizedException()
    }
  }

  // The authn-DENY audit emission (IDs only, S4/5c: the presented secret is
  // never read here, let alone logged). Shared by the fail-fast header check
  // and the full resolve failure path so both emit an identical shape.
  private async denyUnauthenticated(traceId: string, reasonCode: string): Promise<void> {
    await emitVendorAuthzAudit(this.deps.fulfillmentDb, {
      principalId: 'unknown',
      cls: 6,
      operation: 'authenticate',
      decision: 'DENY',
      outcome: 'denied',
      reasonCode,
      actorChannel: 'vendor-edge',
      traceId,
    })
  }
}
