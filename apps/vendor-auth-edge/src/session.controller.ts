import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common'
import { randomUUID, createHash } from 'node:crypto'
import { vendorLogin } from '@andpay/auth-service'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'
import { serializeVendorRefreshCookie } from './cookies.js'
import { sourceKey } from './request.js'

// The minimal response shape this controller writes to (mirrors
// apps/auth-edge/src/login.controller.ts's EdgeResponse: this repo does not
// depend on @types/express, so the edge types @Res structurally by the ONE
// method it calls). @Res is used with { passthrough: true } so Nest still
// serializes the returned JSON body.
interface EdgeResponse {
  setHeader(name: string, value: string): void
}

// The minimal request shape this controller reads: exactly what sourceKey
// needs (the X-Forwarded-For first hop else the socket peer). Kept
// structural, mirroring auth-edge's ThrottleRequest.
interface ThrottleRequest {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}

// The FIRST real endpoint on vendor-auth-edge and the vendor token PRODUCER
// seam (spec 14a task 9). It calls `vendorLogin(...)` in @andpay/auth-service
// (Task 6), which verifies the password + TOTP second factor, enforces the
// class-7 AAL2 assurance floor (a password-only attempt is AAL1 and cannot
// reach the AAL2 floor: it is DENIED), mints the D122 vendor-plane access
// token via the injected multi-key signer, and opens a vendor refresh-token
// family. On success the refresh token is set ONLY as an HttpOnly cookie
// (check 5, cookies.ts's serializeVendorRefreshCookie) and the access token
// is returned in the JSON body ONLY (never a cookie). `mode` is live-only
// and is set inside vendorLogin from a constant, never read from the body.
@Controller('session')
export class SessionController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: VendorAuthEdgeDeps) {}

  // A successful login is a 200, not Nest's default POST 201: no resource is
  // created at a new URL the caller can GET; the session is the effect and it
  // rides in the body + Set-Cookie.
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { handle?: string; password?: string; totp?: string },
    @Req() req: ThrottleRequest,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<{ accessToken: string }> {
    // 6d brute-force control, FIRST, before any argon2/DB work: charge the
    // per-SOURCE token bucket so a burst is rejected cheaply. The key is the
    // request source (origin IP), NEVER the credential, so a third party can
    // never lock out a victim by failing that victim's logins; there is no
    // per-principal hard lockout. The throttle FAILS OPEN on its own store
    // failure: if take() throws, login proceeds (auth still serves).
    const key = sourceKey(req)
    let allowed = true
    try {
      allowed = await this.deps.throttle.take(key)
    } catch {
      allowed = true
    }
    // A generic 429 with NO token/reasonCode/credential detail. This
    // HttpException is NOT an AuthzError/EdgeAuthError, so
    // VendorAuthErrorFilter delegates it to Nest's own BaseExceptionFilter
    // (super.catch) and it stays a real 429, never folded into the login 401.
    if (!allowed) throw new HttpException('too many requests', HttpStatus.TOO_MANY_REQUESTS)

    // A missing handle/password is the same uniform 401 as a bad credential:
    // no reasonCode, no hint about which field was absent.
    if (!body?.handle || !body?.password) throw new UnauthorizedException()
    try {
      const result = await vendorLogin(body.handle, body.password, body.totp, {
        db: this.deps.authDb,
        signer: this.deps.signer,
        mfa: this.deps.mfa,
        mfaSecretResolver: this.deps.mfaSecretResolver,
        iss: this.deps.expectedIss,
        accessTtlSec: this.deps.accessTtlSec,
        idleSec: this.deps.idleSec,
        absoluteSec: this.deps.absoluteSec,
        // A fixed, non-PII client-bind value: the family is pinned to this
        // edge, not to any request-supplied or personally-identifying token.
        clientBind: createHash('sha256').update('vendor-auth-edge').digest('hex').slice(0, 16),
        traceId: randomUUID(),
      })
      // check 5: the refresh token rides ONLY in the HttpOnly cookie; the
      // access token rides ONLY in the JSON body. The two never cross
      // transports.
      res.setHeader('Set-Cookie', serializeVendorRefreshCookie(result.refreshToken, this.deps.absoluteSec))
      return { accessToken: result.accessToken }
    } catch {
      // vendorLogin already committed the 6e DENY synchronously before it
      // threw. The HTTP body stays generic: no reasonCode, no token, no
      // which-factor-failed signal. Uniform 401 for every failure mode
      // (unknown handle, wrong password, wrong/absent TOTP, assurance floor
      // unmet).
      throw new UnauthorizedException()
    }
  }
}
