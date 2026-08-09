import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common'
import { randomUUID, createHash } from 'node:crypto'
import { login } from '@andpay/auth-service'
import { EDGE_DEPS, type AuthEdgeDeps } from './deps.js'
import { serializeRefreshCookie } from './cookies.js'
import { sourceKey } from './request.js'

// The minimal response shape this controller writes to (mirrors the
// ops-edge/tenant-edge ReportsController: this repo does not depend on
// `@types/express`, so the edges type @Res structurally by the ONE method they
// call rather than pulling the whole express Response type). @Res is used with
// { passthrough: true } so Nest still serializes the returned JSON body.
interface EdgeResponse {
  setHeader(name: string, value: string): void
}

// The minimal request shape this controller reads: exactly what sourceKey needs
// (the X-Forwarded-For first hop else the socket peer). Kept structural (not the
// full express Request) so the controller stays framework-light, mirroring
// EdgeResponse above.
interface ThrottleRequest {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}

// The FIRST real endpoint on auth-edge and the token PRODUCER seam (spec 12
// task 9). It calls `login(...)` in @andpay/auth-service, which verifies the
// password + second factor, enforces the role's assurance floor (a
// password-only attempt is AAL1 and cannot reach the AAL2 floor: it is
// DENIED), mints the D3 internal-admin access token via the injected KMS
// signer, and opens a refresh-token family. On success the refresh token is
// set ONLY as an HttpOnly cookie (check 5) and the access token is returned in
// the JSON body ONLY (never a cookie). `mode` is live-only and is set inside
// login from a constant, never read from the body (check 8).
@Controller('session')
export class LoginController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: AuthEdgeDeps) {}

  // A successful login is a 200, not Nest's default POST 201: no resource is
  // created at a new URL the caller can GET; the session is the effect and it
  // rides in the body + Set-Cookie.
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { handle?: string; password?: string; totp?: string },
    @Req() req: ThrottleRequest,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<{ accessToken?: string; enrollmentRequired?: boolean; mfaRequired?: boolean }> {
    // 6d brute-force control (spec 12 task 12), FIRST, before any argon2/DB
    // work: charge the per-SOURCE token bucket so a burst is rejected cheaply.
    // The key is the request source (origin IP), NEVER the credential, so a
    // third party can never lock out a victim by failing that victim's logins;
    // there is no per-principal hard lockout. The throttle FAILS OPEN on its
    // own store failure: if take() throws, login proceeds (auth still serves).
    const key = sourceKey(req)
    let allowed = true
    try {
      allowed = await this.deps.throttle.take(key)
    } catch {
      allowed = true
    }
    // A generic 429 with NO token/reasonCode/credential detail, consistent with
    // the logger:false + uniform-response posture. This HttpException is NOT an
    // AuthzError/EdgeAuthError, so AuthErrorFilter delegates it to Nest's own
    // BaseExceptionFilter (super.catch) and it stays a real 429, never folded
    // into the login 401.
    if (!allowed) throw new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS)

    // A missing handle/password is the same uniform 401 as a bad credential:
    // no reasonCode, no hint about which field was absent.
    if (!body?.handle || !body?.password) throw new UnauthorizedException()
    try {
      const result = await login(body.handle, body.password, body.totp, {
        db: this.deps.authDb,
        signer: this.deps.signer,
        mfa: this.deps.mfa,
        resolveSecretRef: this.deps.resolveSecretRef,
        iss: this.deps.expectedIss,
        accessTtlSec: this.deps.accessTtlSec,
        idleSec: this.deps.idleSec,
        absoluteSec: this.deps.absoluteSec,
        // A fixed, non-PII client-bind value: the family is pinned to this edge,
        // not to any request-supplied or personally-identifying token.
        clientBind: createHash('sha256').update('auth-edge').digest('hex').slice(0, 16),
        traceId: randomUUID(),
      })
      // Password verified, enrolled factor not yet presented. No token, no
      // cookie: the caller is told to continue to the code step.
      if (result.mfaRequired === true) {
        return { mfaRequired: true }
      }
      // First-login enrollment outcome: no refresh family was opened, so there
      // is no cookie to set. The body flags it so the portal can route to the
      // setup screen. The token in the body is enrollment-only (one permission,
      // short TTL), so flagging it reveals nothing a caller could not already
      // read from its own token.
      if (result.enrollmentRequired === true || result.refreshToken === undefined) {
        return { accessToken: result.accessToken!, enrollmentRequired: true }
      }
      // A session outcome always carries a token.
      if (result.accessToken === undefined) throw new UnauthorizedException()
      // check 5: the refresh token rides ONLY in the HttpOnly cookie; the access
      // token rides ONLY in the JSON body. The two never cross transports.
      res.setHeader('Set-Cookie', serializeRefreshCookie(result.refreshToken, this.deps.absoluteSec, { secure: this.deps.cookieSecure ?? true }))
      return { accessToken: result.accessToken }
    } catch {
      // login already committed the 6e DENY synchronously before it threw. The
      // HTTP body stays generic: no reasonCode, no token, no which-factor-failed
      // signal. Uniform 401 for every failure mode (unknown handle, wrong
      // password, wrong/absent TOTP, assurance floor unmet).
      throw new UnauthorizedException()
    }
  }
}
