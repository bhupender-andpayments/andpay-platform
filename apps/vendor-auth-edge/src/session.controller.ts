import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common'
import { randomUUID, createHash } from 'node:crypto'
import {
  vendorLogin,
  rotateRefresh,
  logoutByRefreshToken,
  issueAccessToken,
  VENDOR_PLANE,
  VENDOR_OPERATOR_SET_NAME,
} from '@andpay/auth-service'
import { verifyAccessToken, type Acr, type Amr } from '@andpay/authz'
import { EDGE_DEPS, type VendorAuthEdgeDeps } from './deps.js'
import { serializeVendorRefreshCookie, clearVendorRefreshCookie } from './cookies.js'
import { sourceKey, readRefreshCookie, readBearer } from './request.js'

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

  // A successful refresh is a 200 (a rotated session, not a newly-created
  // resource at a new URL): the fresh access token rides in the body, the
  // fresh refresh token rides in the rotated Set-Cookie, exactly as login
  // splits them. Mirrors apps/auth-edge/src/session.controller.ts's refresh
  // (spec 12 task 10), adapted for the class-7 vendor audience
  // (VENDOR_PLANE, principalType:'vendor_operator', vendor_operator row).
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Headers('cookie') cookieHeader: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<{ accessToken: string }> {
    // The opaque refresh token is the PRIMARY control: no cookie, no rotation.
    const presented = readRefreshCookie(cookieHeader)
    if (!presented) {
      res.setHeader('Set-Cookie', clearVendorRefreshCookie())
      throw new UnauthorizedException()
    }

    // CSRF binding (defense-in-depth; SameSite=Strict is the primary CSRF
    // control): the caller must also present its in-memory access token. That
    // token is expiring (which is WHY the client is refreshing), so it is
    // verified for signature + issuer + audience(andpay:vendor) + mode but with
    // its expiry tolerated via a leeway equal to the family idle window
    // (deps.idleSec), mirroring auth-edge's refresh handler exactly. Verified
    // BEFORE the rotation so a missing/forged/foreign-plane token 401s WITHOUT
    // burning a rotation.
    const bearer = readBearer(authorization)
    if (!bearer) {
      res.setHeader('Set-Cookie', clearVendorRefreshCookie())
      throw new UnauthorizedException()
    }
    let boundSub: string
    try {
      const claims = await verifyAccessToken(bearer, {
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
        expectedAud: VENDOR_PLANE,
        expectedMode: this.deps.expectedMode,
        leewaySec: this.deps.idleSec,
      })
      boundSub = claims.sub
    } catch {
      res.setHeader('Set-Cookie', clearVendorRefreshCookie())
      throw new UnauthorizedException()
    }

    // Re-derive the session's assurance from the bound principal's row. The
    // refresh_token row carries neither acr/amr nor the vendor_operator's
    // status, and no Session row is written at login, so the vendor_operator
    // row is the only durable source. A suspended/revoked operator must not
    // keep a live vendor session alive by refreshing, so a non-ACTIVE/absent
    // operator 401s here (before the rotation is spent). Class 7 is a SINGLE
    // fixed-assurance role (D122, Field 8): there is no per-operator role
    // lookup (unlike the internal-admin path), so the achieved acr is always
    // the fixed AAL2 floor vendorLogin enforces at login.
    const operator = await this.deps.authDb.vendorOperator.findUnique({ where: { id: boundSub } })
    if (!operator || operator.status !== 'ACTIVE') {
      res.setHeader('Set-Cookie', clearVendorRefreshCookie())
      throw new UnauthorizedException()
    }
    const acr: Acr = 'AAL2'
    const amr: Amr[] = ['pwd', 'otp']

    const now = Math.floor(Date.now() / 1000)
    const traceId = randomUUID()

    // Rotate the family: a reused/revoked/idle/absolute-expired token throws
    // an AuthzError which the app-wide error filter maps to a generic 401.
    // principalType:'vendor_operator' (task 5) so this can never rotate an
    // internal family's token even if a tokenHash collided (it cannot: the
    // hash is over the opaque token bytes, not over principalId).
    let rotated: { refreshToken: string; principalId: string }
    try {
      rotated = await rotateRefresh(presented, {
        db: this.deps.authDb,
        idleSec: this.deps.idleSec,
        now,
        principalType: 'vendor_operator',
        audit: {
          principalId: boundSub,
          cls: 7,
          operation: 'refresh',
          decision: 'ALLOW',
          resourceIds: [],
          outcome: 'rotated',
          acr,
          traceId,
        },
        revokeAudit: {
          principalId: boundSub,
          cls: 7,
          operation: 'refresh',
          decision: 'DENY',
          resourceIds: [],
          outcome: 'reuse-family-revoked',
          reasonCode: 'refresh-reuse',
          traceId,
        },
      })
    } catch {
      res.setHeader('Set-Cookie', clearVendorRefreshCookie())
      throw new UnauthorizedException()
    }

    // The CSRF binding: the bound access token's subject MUST be the rotated
    // family's principal. A mismatch 401s; the rotation is already spent, but
    // a mismatch is an attack signal SameSite=Strict already blocks, so
    // burning that one rotation is an acceptable, safe outcome.
    if (rotated.principalId !== boundSub) {
      res.setHeader('Set-Cookie', clearVendorRefreshCookie())
      throw new UnauthorizedException()
    }

    // Mint the successor access token via the SAME claims shape vendorLogin
    // uses (cls 7, live, VENDOR_PLANE, scope.vndr re-derived from the row,
    // psr vset:vendor_operator, epoch 1, acr/amr). auth_time is deliberately
    // OMITTED: a silent refresh is NOT a re-authentication, so it must not
    // reset the step-up freshness clock.
    const accessToken = await issueAccessToken(
      {
        principalId: rotated.principalId,
        cls: 7,
        mode: this.deps.expectedMode,
        scope: { vndr: operator.vndrId },
        psr: `vset:${VENDOR_OPERATOR_SET_NAME}`,
        epoch: 1,
        aud: VENDOR_PLANE,
        acr,
        amr,
      },
      { signer: this.deps.signer, iss: this.deps.expectedIss, ttlSec: this.deps.accessTtlSec, now },
    )

    // Rotate the cookie: a FRESH andpay_vendor_rt with the same security flags.
    res.setHeader('Set-Cookie', serializeVendorRefreshCookie(rotated.refreshToken, this.deps.absoluteSec))
    return { accessToken }
  }

  // Logout revokes the entire refresh-token family so the next rotate 401s,
  // then clears the cookie. Idempotent: a missing or unknown cookie still
  // clears and returns 204 (no body). No CSRF binding is required to revoke:
  // a revoke is not sensitive, is idempotent, and SameSite=Strict already
  // gates the cookie. principalType:'vendor_operator' so this can only ever
  // kill a vendor family, never an internal one.
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<void> {
    const presented = readRefreshCookie(cookieHeader)
    if (presented) await logoutByRefreshToken(this.deps.authDb, presented, randomUUID(), 'vendor_operator')
    res.setHeader('Set-Cookie', clearVendorRefreshCookie())
  }
}
