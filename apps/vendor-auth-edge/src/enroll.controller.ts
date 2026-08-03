import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common'
import { enrollTotp } from '@andpay/auth-service'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'
import { VendorAuthEdgeAdminGuard } from './admin.guard.js'
import type { EdgeRequest } from './request.js'

// The enroll request body carries TARGET params ONLY (D99, M7/S16): the
// actor (`sub`) comes from the verified claim the guard attached, never from
// here. A spoofed actor/identity field in this body is simply never read.
interface EnrollBody {
  principalId: string
  accountLabel: string
}

// POST /enroll (spec 14a task 11, check 3): an authenticated class-3 admin
// admin-seeds a TOTP enrollment for a vendor_operator. @UseGuards is
// declared at the CLASS level so the route is authenticated by construction
// (VendorAuthEdgeAdminGuard: local verify against the internal-admin plane,
// cls===3 required). Unlike apps/auth-edge's spec-12 enroll route, there is
// no separate authorize()/step-up gate here: the admin guard IS the sole
// authority gate for this dedicated vendor-onboarding edge (no in-band
// mfa:enroll permission or step-up-freshness concept exists on the class-7
// vendor plane this edge serves).
//
// On success enrollTotp generates the secret, custodies it via the
// vendor-keyed storeSecret seam (the raw secret NEVER touches the DB row or
// a log line, S4/5c), writes the mfa_enrollment row under auth_write with a
// co-committed 6e ALLOW audit (principalType:'vendor_operator', check 4),
// and returns the otpauth:// provisioning URI ONCE. The edge returns exactly
// that URI.
@Controller()
@UseGuards(VendorAuthEdgeAdminGuard)
export class EnrollController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: VendorAuthEdgeDeps) {}

  @Post('enroll')
  @HttpCode(200)
  async enroll(@Req() req: EdgeRequest, @Body() body: EnrollBody): Promise<{ otpauthUri: string }> {
    // The actor is the VERIFIED claim subject, NEVER the request body (D99,
    // M7/S16). The target params are the only values taken from the body.
    const { otpauthUri } = await enrollTotp(this.deps.authDb, {
      targetPrincipalId: body.principalId,
      targetAccountLabel: body.accountLabel,
      enrolledByActor: req.claim.sub,
      issuer: this.deps.totpIssuer,
      storeSecret: this.deps.storeSecret,
      principalType: 'vendor_operator',
      traceId: req.traceId,
    })
    return { otpauthUri }
  }
}
