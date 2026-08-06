import { Body, Controller, ForbiddenException, Headers, HttpCode, HttpException, HttpStatus, Inject, Post, Req, UnauthorizedException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { stepUp, INTERNAL_ADMIN_PLANE } from '@andpay/auth-service'
import { AuthzError, verifyAccessToken } from '@andpay/authz'
import { EDGE_DEPS, type AuthEdgeDeps } from './deps.js'
import { sourceKey, readBearer } from './request.js'

// The minimal request shape this controller reads for sourceKey: exactly the
// X-Forwarded-For first hop else the socket peer. Kept structural (not the full
// express Request) so the controller stays framework-light, mirroring
// LoginController's ThrottleRequest.
interface ThrottleRequest {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}

// POST /session/stepup (spec 12a task 2): tier-1 step-up (6b, S15). The caller
// re-presents its enrolled TOTP against the CURRENT class-3 session (proven by
// the live internal-admin access token in the Authorization header) to mint a
// fresh-auth_time D3 claim. It does NOT rotate the refresh family and sets NO
// cookie: the fresh access token rides in the JSON body ONLY, exactly the split
// login/refresh use, but without the Set-Cookie leg.
//
// `sub` and `mode` are NEVER read from the body (M7/S16): the actor is the
// verified session claim's subject and the mode is the pinned edge mode carried
// on that claim. The body carries only the re-presented TOTP.
@Controller('session')
export class StepUpController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: AuthEdgeDeps) {}

  // A successful step-up is a 200, not a 201: no resource is created at a new
  // URL, the fresh token is the effect and it rides in the body.
  @Post('stepup')
  @HttpCode(200)
  async stepup(
    @Body() body: { totp?: string },
    @Headers('authorization') authorization: string | undefined,
    @Req() req: ThrottleRequest,
  ): Promise<{ accessToken: string }> {
    // 6d brute-force control FIRST, before any DB/TOTP work: charge the
    // per-SOURCE token bucket (the SAME shared bucket login uses), keyed by the
    // request source (origin IP), NEVER the credential. Fails OPEN on its own
    // store failure so auth still serves. A drained bucket is a real 429 (this
    // HttpException is not an AuthzError, so AuthErrorFilter delegates it to
    // Nest's own filter and it stays a 429, never folded into a 401).
    const key = sourceKey(req)
    let allowed = true
    try {
      allowed = await this.deps.throttle.take(key)
    } catch {
      allowed = true
    }
    if (!allowed) throw new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS)

    // Read and verify the CURRENT session access token. DEFAULT leeway (no
    // idle-window tolerance): an EXPIRED session token 401s here, because a
    // step-up must prove a LIVE session, unlike refresh which deliberately
    // tolerates an expiring token. A missing header, a malformed token, a wrong
    // signer/issuer/audience/mode, or a non-class-3 claim is a uniform 401
    // (authentication of the presented session failed).
    const bearer = readBearer(authorization)
    if (!bearer) throw new UnauthorizedException()
    let claim
    try {
      claim = await verifyAccessToken(bearer, {
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
        expectedAud: INTERNAL_ADMIN_PLANE,
        expectedMode: this.deps.expectedMode,
      })
    } catch {
      throw new UnauthorizedException()
    }
    if (claim.cls !== 3) throw new UnauthorizedException()

    // Mint the fresh-auth_time claim. stepUp re-presents the TOTP, and on a
    // failed factor commits a SYNCHRONOUS STANDALONE 6e DENY audit BEFORE it
    // throws AuthzError('mfa-failed') (the Q1 pure-DENY pattern). We map that
    // AuthzError to a 403 HERE, because the app-wide AuthErrorFilter would
    // otherwise fold it into a 401; a valid session whose elevation is denied is
    // a 403, DISTINCT from the 401 of a failed session authentication above.
    //
    // A NON-AuthzError (an audit-commit failure, a signer failure, any infra
    // error) PROPAGATES unchanged so it becomes a 500: a response is NEVER
    // observable with 0 audit rows (check 3, durable-before-observable). No
    // reasonCode/token reaches the HTTP body.
    try {
      return await stepUp(claim, body.totp ?? '', {
        db: this.deps.authDb,
        signer: this.deps.signer,
        mfa: this.deps.mfa,
        resolveSecretRef: this.deps.resolveSecretRef,
        iss: this.deps.expectedIss,
        accessTtlSec: this.deps.accessTtlSec,
        traceId: randomUUID(),
      })
    } catch (err) {
      if (err instanceof AuthzError) throw new ForbiddenException()
      throw err
    }
  }
}
