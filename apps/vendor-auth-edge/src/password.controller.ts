import { randomUUID } from 'node:crypto'
import { Body, Controller, Headers, HttpCode, Inject, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common'
import { changeVendorPassword, adminResetVendorPassword, VENDOR_PLANE } from '@andpay/auth-service'
import { verifyAccessToken, AuthzError } from '@andpay/authz'
import { EdgeAuthError } from '@andpay/edge'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'
import { VendorAuthEdgeAdminGuard } from './admin.guard.js'
import { readBearer } from './request.js'
import type { EdgeRequest } from './request.js'

// Spec 14a task 12: the two password-lifecycle routes on vendor-auth-edge.
// POST /password/change is a class-7 SELF-SERVICE route (a live vendor
// session changing its OWN password): there is no @UseGuards class-level
// authority gate here (unlike the admin-guarded routes), because this route's
// authenticated principal IS the target, verified inline against the SAME
// keyset/plane the refresh handler verifies against (VENDOR_PLANE, cls===7,
// RFC 8725 already enforced by verifyAccessToken). The operatorId is ALWAYS
// the verified claim's `sub`, NEVER a body field (D99, M7/S16): a caller
// cannot change another operator's password by supplying a different id in
// the body, because the body carries no id field at all.
//
// POST /password/admin-reset is class-3-admin-guarded (the SAME
// VendorAuthEdgeAdminGuard the provision/enroll routes use): the target
// operatorId is a body field (an admin acts on a DIFFERENT principal), the
// actor is the verified admin claim's `sub`, and there is no current-password
// check (admin authority, granted upstream by the guard).
//
// There is deliberately NO self-service forgot-password/reset route: the
// only way to recover a forgotten password is the class-3 admin-reset path.
interface ChangePasswordBody {
  currentPassword?: string
  newPassword?: string
}

interface AdminResetPasswordBody {
  operatorId?: string
  newPassword?: string
}

@Controller('password')
export class PasswordController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: VendorAuthEdgeDeps) {}

  @Post('change')
  @HttpCode(204)
  async change(@Headers('authorization') authorization: string | undefined, @Body() body: ChangePasswordBody): Promise<void> {
    // CLASS-7 SESSION check, verified LOCALLY against this edge's own vendor
    // JWKS (zero call to Auth on the request path), mirroring the refresh
    // handler's inline verify exactly (VENDOR_PLANE, live mode, RFC 8725
    // already enforced by verifyAccessToken). Any failure, for any reason
    // (missing bearer, bad signature, wrong iss/aud/mode, expired, denylisted,
    // or a validly-signed token whose class is not 7) is a GENERIC 401: no
    // reasonCode, no hint about which check failed.
    const bearer = readBearer(authorization)
    if (!bearer) throw new UnauthorizedException()

    let sub: string
    try {
      const claim = await verifyAccessToken(bearer, {
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
        expectedAud: VENDOR_PLANE,
        expectedMode: this.deps.expectedMode,
      })
      if (claim.cls !== 7) throw new UnauthorizedException()
      sub = claim.sub
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e
      if (!(e instanceof AuthzError) && !(e instanceof EdgeAuthError)) throw e
      throw new UnauthorizedException()
    }

    // changeVendorPassword throws AuthzError('authn-failed') on a wrong
    // current password (it has ALREADY committed the synchronous standalone
    // 6e DENY before it throws); the app-wide VendorAuthErrorFilter maps that
    // to the same generic 401 as every other authn failure on this edge (no
    // factor leak).
    await changeVendorPassword(this.deps.authDb, {
      operatorId: sub,
      currentPassword: body.currentPassword ?? '',
      newPassword: body.newPassword ?? '',
      traceId: randomUUID(),
    })
  }

  @Post('admin-reset')
  @HttpCode(204)
  @UseGuards(VendorAuthEdgeAdminGuard)
  async adminReset(@Req() req: EdgeRequest, @Body() body: AdminResetPasswordBody): Promise<void> {
    // The actor is the VERIFIED class-3 admin claim's `sub`, NEVER the
    // request body (D99, M7/S16). The target operatorId IS a body field
    // here (the admin acts on a different principal); no current-password
    // check (admin authority, granted upstream by the guard).
    await adminResetVendorPassword(this.deps.authDb, {
      operatorId: body.operatorId ?? '',
      newPassword: body.newPassword ?? '',
      actor: req.claim.sub,
      traceId: req.traceId,
    })
  }
}
