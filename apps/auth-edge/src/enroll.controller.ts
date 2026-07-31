import { Body, Controller, ForbiddenException, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common'
import { authorize, requireStepUp } from '@andpay/authz'
import { enrollTotp, STEP_UP_CATALOG } from '@andpay/auth-service'
import { EDGE_DEPS, type AuthEdgeDeps } from './deps.js'
import { AuthEdgeAdminGuard } from './admin.guard.js'
import type { EdgeRequest } from './request.js'

// A local wall-clock read in whole seconds for the step-up freshness check
// (auth_time is a second-resolution claim). Date.now() is permitted in app
// runtime code; the value is compared, never persisted, so it introduces no
// non-determinism into any fact. Mirrors ops-edge's nowSec.
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// The enroll request body carries TARGET params ONLY (D99, M7/S16): the actor
// (`sub`) comes from the verified claim the guard attached, never from here. A
// spoofed actor/identity field in this body is simply never read.
interface EnrollBody {
  targetPrincipalId: string
  targetAccountLabel: string
}

// POST /enroll (spec 12 task 11, check 3): an authenticated class-3 admin seeds
// a TOTP enrollment for a target principal. @UseGuards is declared at the CLASS
// level so the route is authenticated by construction. The guard verifies the
// admin's internal-admin token locally (authn -> 401 on failure) and attaches
// the verified claim + traceId.
//
// The authz gate here is the mfa:enroll permission (only `admin` and the
// super_admin '*' hold it; ops/support do not) AND the step-up freshness gate
// (AAL2 with a 300s auth_time freshness, off STEP_UP_CATALOG['mfa:enroll']). A
// valid admin-plane token that lacks the permission, or whose step-up freshness
// is not met (e.g. a token re-minted by a silent refresh, which omits
// auth_time), is a 403, DISTINCT from the guard's 401.
//
// On success enrollTotp generates the secret, custodies it (the raw secret
// NEVER touches the DB row or a log line, S4/5c), writes the mfa_enrollment row
// under auth_write with a co-committed 6e ALLOW audit (check 4), and returns
// the otpauth:// provisioning URI ONCE. The edge returns exactly that URI.
@Controller()
@UseGuards(AuthEdgeAdminGuard)
export class EnrollController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: AuthEdgeDeps) {}

  @Post('enroll')
  @HttpCode(200)
  async enroll(@Req() req: EdgeRequest, @Body() body: EnrollBody): Promise<{ otpauthUri: string }> {
    // Step-up freshness (AAL2 + 300s off auth_time) THEN the D2 authorize, both
    // read off the VERIFIED claim, both LOCAL (T4). A failure of either is a
    // uniform 403: a valid admin-plane token that is either not fresh enough or
    // lacks mfa:enroll is forbidden, never a 401 (which is reserved for a failed
    // authentication at the guard).
    const entry = STEP_UP_CATALOG['mfa:enroll']
    if (entry === undefined) throw new ForbiddenException()
    try {
      requireStepUp(req.claim, entry, nowSec())
    } catch {
      throw new ForbiddenException()
    }
    const decision = authorize(req.claim, 'mfa:enroll', {}, this.deps.roleConfig)
    if (!decision.allowed) throw new ForbiddenException()

    // The actor is the VERIFIED claim subject, NEVER the request body (D99,
    // M7/S16). The target params are the only values taken from the body.
    const { otpauthUri } = await enrollTotp(this.deps.authDb, {
      targetPrincipalId: body.targetPrincipalId,
      targetAccountLabel: body.targetAccountLabel,
      enrolledByActor: req.claim.sub,
      issuer: this.deps.totpIssuer,
      storeSecret: this.deps.storeSecret,
      traceId: req.traceId,
    })
    return { otpauthUri }
  }
}
