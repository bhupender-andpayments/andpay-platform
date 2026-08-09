import { Controller, Headers, HttpCode, Inject, Post, Res, UnauthorizedException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  rotateRefresh,
  rehydrateSession,
  logoutByRefreshToken,
  issueAccessToken,
  INTERNAL_ADMIN_PLANE,
} from '@andpay/auth-service'
import { verifyAccessToken, type Acr, type Amr } from '@andpay/authz'
import { EDGE_DEPS, type AuthEdgeDeps } from './deps.js'
import { readRefreshCookie } from './request.js'
import { serializeRefreshCookie, clearRefreshCookie } from './cookies.js'

// The minimal response shape these controllers write to (same structural @Res
// pattern as LoginController: this repo does not depend on @types/express, so
// the edge types @Res by the ONE method it calls). @Res is used with
// { passthrough: true } so Nest still serializes the returned JSON body (refresh)
// and honors the @HttpCode (logout's 204).
interface EdgeResponse {
  setHeader(name: string, value: string): void
}

// The two-arg Bearer split for the CSRF-binding access token. Returns undefined
// for a missing or malformed Authorization header (any non-Bearer scheme, an
// empty credential), so the caller maps it to the same uniform 401.
function readBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined
  const [scheme, token] = authorization.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined
  return token
}

// The canonical authentication-method set for a v1 session's assurance level.
// The refresh_token row does NOT persist acr/amr; a silent refresh re-derives
// the session's assurance from the principal's role floor (see refresh() below).
// In v1 the ONLY second factor wired is TOTP and AAL3 (WebAuthn) is structurally
// unreachable, so an AAL2 session was reached with exactly password + TOTP. amr
// is informational only (no check consults it; acr is the load-bearing claim),
// so this mapping mirrors login's amr shape without claiming a factor that was
// not available in v1.
function amrForAcr(acr: Acr): Amr[] {
  if (acr === 'AAL3') return ['pwd', 'hwk']
  if (acr === 'AAL2') return ['pwd', 'otp']
  return ['pwd']
}

// The refresh-family lifecycle seam (spec 12 task 10, check 2): rotate on
// /session/refresh, revoke on /session/logout. Both routes live on the same
// @Controller('session') as login (Path=/session is exactly the scope the
// refresh cookie is pinned to in cookies.ts), so the browser only ever presents
// andpay_rt on these routes.
@Controller('session')
export class SessionController {
  constructor(@Inject(EDGE_DEPS) private readonly deps: AuthEdgeDeps) {}

  // A successful refresh is a 200 (a rotated session, not a newly-created
  // resource at a new URL): the fresh access token rides in the body, the fresh
  // refresh token rides in the rotated Set-Cookie, exactly as login splits them.
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Headers('cookie') cookieHeader: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<{ accessToken: string }> {
    // The opaque refresh token is the PRIMARY control: no cookie, no rotation.
    const presented = readRefreshCookie(cookieHeader)
    if (!presented) throw new UnauthorizedException()

    // CSRF binding (defense-in-depth; SameSite=Strict is the primary CSRF
    // control): the caller must also present its in-memory access token. That
    // token is expiring (which is WHY the client is refreshing), so it is
    // verified for signature + issuer + audience(internal-admin) + mode but with
    // its expiry tolerated. verifyAccessToken has NO ignore-expiry option, only a
    // clock-skew leewaySec, so expiry is tolerated via a leeway equal to the
    // family idle window (deps.idleSec): an access token staler than idleSec
    // implies the refresh family is itself idle-dead, so rotateRefresh below 401s
    // regardless. A leeway of idleSec therefore never accepts a token the primary
    // control would reject, and never rejects a legitimate silent refresh inside
    // the idle window. Verified BEFORE the rotation so a missing/forged/foreign-
    // plane token 401s WITHOUT burning a rotation.
    const bearer = readBearer(authorization)
    if (!bearer) throw new UnauthorizedException()
    let boundSub: string
    try {
      const claims = await verifyAccessToken(bearer, {
        jwks: this.deps.jwks,
        expectedIss: this.deps.expectedIss,
        expectedAud: INTERNAL_ADMIN_PLANE,
        expectedMode: this.deps.expectedMode,
        leewaySec: this.deps.idleSec,
      })
      boundSub = claims.sub
    } catch {
      throw new UnauthorizedException()
    }

    // Re-derive the session's assurance and permission-set reference from the
    // bound principal's role. The refresh_token row carries neither acr/amr nor
    // the role, and no Session row is written at login, so the principal row is
    // the only durable source. A deactivated or deleted principal must not keep a
    // live admin session alive by refreshing, so a non-ACTIVE/absent principal
    // 401s here (before the rotation is spent). In v1 the achieved acr equals the
    // role's required floor for every session that can exist (AAL3 is unreachable,
    // so a login reaches EXACTLY its floor, never above it), so the role floor IS
    // the assurance the session had. This is a re-derivation, not an invented
    // level; when variable/above-floor assurance lands the acr must instead be
    // carried forward from persisted session state.
    const principal = await this.deps.authDb.internalPrincipal.findUnique({ where: { id: boundSub } })
    if (!principal || principal.status !== 'ACTIVE') throw new UnauthorizedException()
    const role = this.deps.roleConfig.roles[principal.role]
    if (!role) throw new UnauthorizedException()
    const acr: Acr = role.requiredAcr

    const now = Math.floor(Date.now() / 1000)
    const traceId = randomUUID()

    // Rotate the family: a reused/revoked/idle/absolute-expired token throws an
    // AuthzError which the app-wide AuthErrorFilter maps to a generic 401. The
    // refresh-ALLOW and reuse-revoke DENY audits co-commit INSIDE rotateRefresh's
    // tx (the params task 3 added), so an aborted rotation leaves 0 refresh rows
    // AND 0 authz.audit rows (check 4). Their principalId is boundSub, the CSRF-
    // bound subject, which the post-rotation check below pins to the rotated
    // family's principal.
    const { refreshToken, principalId } = await rotateRefresh(presented, {
      db: this.deps.authDb,
      idleSec: this.deps.idleSec,
      now,
      audit: {
        principalId: boundSub,
        cls: 3,
        operation: 'refresh',
        decision: 'ALLOW',
        resourceIds: [],
        outcome: 'rotated',
        acr,
        traceId,
      },
      revokeAudit: {
        principalId: boundSub,
        cls: 3,
        operation: 'refresh',
        decision: 'DENY',
        resourceIds: [],
        outcome: 'reuse-family-revoked',
        reasonCode: 'refresh-reuse',
        traceId,
      },
    })

    // The CSRF binding: the bound access token's subject MUST be the rotated
    // family's principal. A mismatch (a valid token for a DIFFERENT principal
    // presented with this cookie) 401s. The rotation is already spent by this
    // point, but the edge cannot pre-check the token-to-family binding without
    // hashing the token itself (a C4 violation), and a mismatch is an attack
    // signal SameSite=Strict already blocks, so burning that one rotation is an
    // acceptable, safe outcome.
    if (principalId !== boundSub) throw new UnauthorizedException()

    // Mint the successor access token via the SAME issuer/claims path login uses
    // (cls 3, live, internal-admin, scope {}, psr role:<role>, epoch 1, acr). The
    // access token stays body-only, the refresh token stays cookie-only.
    // auth_time is deliberately OMITTED: a silent refresh is NOT a re-
    // authentication, so it must not reset the step-up freshness clock
    // (requireStepUp gates on auth_time). Omitting it fails step-up CLOSED after a
    // refresh (a high-risk action re-prompts for step-up), which is correct: the
    // original auth_time is not persisted anywhere this path can read it, and
    // stamping now would falsely grant indefinite step-up freshness across silent
    // refreshes.
    const accessToken = await issueAccessToken(
      {
        principalId,
        cls: 3,
        mode: this.deps.expectedMode,
        scope: {},
        psr: `role:${principal.role}`,
        epoch: 1,
        aud: INTERNAL_ADMIN_PLANE,
        acr,
        amr: amrForAcr(acr),
      },
      { signer: this.deps.signer, iss: this.deps.expectedIss, ttlSec: this.deps.accessTtlSec, now },
    )

    // Rotate the cookie: a FRESH andpay_rt with the same security flags. The
    // absolute window is family-wide and does NOT extend on rotation, so the
    // Max-Age is intentionally the full absolute lifetime again (the server-side
    // absoluteExpires, unchanged by rotateRefresh, is the real bound; the cookie
    // Max-Age is only the browser's retention hint).
    res.setHeader('Set-Cookie', serializeRefreshCookie(refreshToken, this.deps.absoluteSec, { secure: this.deps.cookieSecure ?? true }))
    return { accessToken }
  }

  // Cookie-only session rehydrate (Phase 7, GATE 2). A cold browser reload has
  // ALREADY lost its in-memory access token, so unlike /session/refresh this
  // route takes NO Authorization header and NO bearer: the HttpOnly SameSite=
  // Strict andpay_rt cookie is the SOLE credential. CSRF posture is CSRF-A
  // (ratified): SameSite=Strict ALONE is the control here (the cookie is
  // Path=/session-scoped and never rides a cross-site request), with NO bearer
  // bind and NO double-submit token on this path. A missing cookie 401s before
  // any work, exactly like refresh's primary control.
  @Post('rehydrate')
  @HttpCode(200)
  async rehydrate(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<{ accessToken: string }> {
    const presented = readRefreshCookie(cookieHeader)
    if (!presented) throw new UnauthorizedException()

    const now = Math.floor(Date.now() / 1000)
    const traceId = randomUUID()

    // rehydrateSession resolves the family principal C4-internally (the edge
    // stays token-blind: it never hashes the token or reads refresh_token),
    // enforces principal-ACTIVE + role BEFORE spending the rotation, then
    // rotates. A reused/revoked/idle/absolute-expired token, or a deactivated/
    // absent/unknown-role principal, throws an AuthzError the app-wide
    // AuthErrorFilter maps to a generic 401. The refresh-ALLOW and reuse-revoke
    // DENY audits co-commit INSIDE the rotation/revoke tx with principalId = the
    // family's own principal, so a deactivated principal produces NO false
    // refresh-ALLOW audit and NO burned rotation. acr/role are re-derived inside
    // the service and returned here, so the edge does not re-read the principal.
    const { refreshToken, principalId, role, acr } = await rehydrateSession(presented, {
      db: this.deps.authDb,
      roleConfig: this.deps.roleConfig,
      idleSec: this.deps.idleSec,
      now,
      traceId,
    })

    // Mint the successor access token via the SAME issuer/claims path login and
    // refresh use (cls 3, live, internal-admin, scope {}, psr role:<role>, epoch
    // 1, acr, amr). auth_time is DELIBERATELY OMITTED, identical to refresh: a
    // reload is NOT a re-authentication, so it must not reset the step-up
    // freshness clock (requireStepUp gates on auth_time). Omitting it keeps
    // step-up required after a reload, which is correct and safe: the original
    // auth_time is not persisted anywhere this path can read it, and stamping now
    // would falsely grant indefinite step-up freshness across silent reloads.
    const accessToken = await issueAccessToken(
      {
        principalId,
        cls: 3,
        mode: this.deps.expectedMode,
        scope: {},
        psr: `role:${role}`,
        epoch: 1,
        aud: INTERNAL_ADMIN_PLANE,
        acr,
        amr: amrForAcr(acr),
      },
      { signer: this.deps.signer, iss: this.deps.expectedIss, ttlSec: this.deps.accessTtlSec, now },
    )

    // Rotate the cookie: a FRESH andpay_rt with the same security flags and the
    // full absolute lifetime as the browser retention hint (the server-side
    // absoluteExpires, unchanged by rotation, is the real bound).
    res.setHeader('Set-Cookie', serializeRefreshCookie(refreshToken, this.deps.absoluteSec, { secure: this.deps.cookieSecure ?? true }))
    return { accessToken }
  }

  // Logout revokes the entire refresh-token family so the next rotate 401s, then
  // clears the cookie. Idempotent: a missing or unknown cookie still clears and
  // returns 204 (no body). No CSRF binding is required to revoke: a revoke is not
  // sensitive, is idempotent, and SameSite=Strict already gates the cookie.
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) res: EdgeResponse,
  ): Promise<void> {
    const presented = readRefreshCookie(cookieHeader)
    // Token-to-family resolution stays inside the service (C4): the edge never
    // hashes the token or reads refresh_token. logoutByRefreshToken no-ops on an
    // unknown token, so this is safe to call whenever a cookie is present.
    if (presented) await logoutByRefreshToken(this.deps.authDb, presented, randomUUID())
    res.setHeader('Set-Cookie', clearRefreshCookie({ secure: this.deps.cookieSecure ?? true }))
  }
}
