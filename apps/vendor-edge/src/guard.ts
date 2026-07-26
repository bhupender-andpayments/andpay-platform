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
      })
      req.claim = claim
      return true
    } catch (err) {
      const reasonCode = err instanceof EdgeAuthError || err instanceof AuthzError ? err.code : 'authn-error'
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
      throw new UnauthorizedException()
    }
  }
}
