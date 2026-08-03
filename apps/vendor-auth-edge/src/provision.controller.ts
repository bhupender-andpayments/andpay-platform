import { randomUUID } from 'node:crypto'
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common'
import { enrollTotp, provisionVendorOperator } from '@andpay/auth-service'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'
import { VendorAuthEdgeAdminGuard } from './admin.guard.js'
import type { EdgeRequest } from './request.js'

// The provision request body carries TARGET params ONLY (D99, M7/S16): the
// actor (`sub`) comes from the verified claim the guard attached, never from
// here, and `mode` is never read from a body anywhere on this edge (it is
// always the deps-pinned live-only constant). Self-service vendor signup is
// deliberately NOT reachable through any route: this controller is the ONLY
// way a vendor_operator row is created, and it is admin-guarded.
interface ProvisionBody {
  vndrId: string
  username: string
  password: string
}

// POST /provision (spec 14a task 11, check 3): a class-3-authorized admin
// provisions a new vendor_operator (binding the vndr_id scope, admin-seeding
// the password) and, in the SAME request, admin-seeds its TOTP enrollment.
// @UseGuards is declared at the CLASS level (VendorAuthEdgeAdminGuard: local
// verify against the internal-admin plane, cls===3 required), so a class-7
// vendor token or a missing/malformed credential never reaches the handler.
//
// provisionVendorOperator writes the vendor_operator row under auth_write
// and co-commits its own 6e ALLOW audit with `createdByActor` as the
// recorded actor (the class-3 admin's verified `sub`, never a body field).
// enrollTotp then admin-seeds the TOTP factor exactly as the enroll route
// does (principalType:'vendor_operator', the raw secret never touching the
// DB row or a log line, S4/5c), returning the otpauth:// provisioning URI
// ONCE. No password or secret is ever echoed back.
@Controller()
@UseGuards(VendorAuthEdgeAdminGuard)
export class ProvisionController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: VendorAuthEdgeDeps) {}

  @Post('provision')
  @HttpCode(200)
  async provision(@Req() req: EdgeRequest, @Body() body: ProvisionBody): Promise<{ otpauthUri: string }> {
    const { id } = await provisionVendorOperator(this.deps.authDb, {
      vndrId: body.vndrId,
      username: body.username,
      password: body.password,
      createdByActor: req.claim.sub,
      traceId: req.traceId,
    })

    const { otpauthUri } = await enrollTotp(this.deps.authDb, {
      targetPrincipalId: id,
      targetAccountLabel: body.username,
      enrolledByActor: req.claim.sub,
      issuer: this.deps.totpIssuer,
      storeSecret: this.deps.storeSecret,
      principalType: 'vendor_operator',
      traceId: randomUUID(),
    })
    return { otpauthUri }
  }
}
