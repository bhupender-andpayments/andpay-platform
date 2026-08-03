import type { LeanClaim } from '@andpay/authz'
import { VENDOR_REFRESH_COOKIE_NAME } from './cookies.js'

// The shape a future admin/operator guard attaches to the request object for
// a guarded route: `req.claim`, the verified LeanClaim, and `req.traceId`,
// the guard-minted correlation id propagated into a co-committed 6e audit.
// The controller re-derives the actor (`sub`) from the claim ONLY, never a
// request body (D99, M7/S16). Mirrors apps/auth-edge's EdgeRequest.
export interface EdgeRequest {
  claim: LeanClaim
  traceId: string
}

// Request-side helpers shared by the login/refresh/logout controllers
// (Tasks 9 to 12). Kept dependency-free (no cookie-parser): the ONE cookie
// this edge reads is the vendor refresh cookie, so a tiny hand-rolled parser
// over the raw Cookie header is both smaller and easier to reason about than
// a general cookie library.

// Parses the `andpay_vendor_rt` value out of a raw `Cookie` request header.
// Returns undefined when the header is absent or the cookie is not present.
// Values are URL-safe base64url refresh tokens (no `=`/`;`/`,` inside), so a
// simple split on `;` and `=` is sufficient and unambiguous.
export function readRefreshCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === VENDOR_REFRESH_COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return undefined
}

// The two-arg Bearer split for an access token presented in the
// Authorization header. Returns undefined for a missing or malformed header
// (any non-Bearer scheme, an empty credential), so the caller maps it to a
// uniform 401.
export function readBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined
  const [scheme, token] = authorization.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined
  return token
}

// The minimal request shape sourceKey reads. Kept structural (not the full
// express Request) so this helper stays testable and framework-light.
interface ThrottleSourceRequest {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}

// The 6d throttle source key. Behind a trusted reverse proxy the client IP is
// the FIRST hop of X-Forwarded-For (the proxy appends its own address to the
// right); absent that header, the socket peer (`req.ip`) is used. Returns
// 'unknown' only if neither is present, so the bucket always has a stable key
// to charge.
export function sourceKey(req: ThrottleSourceRequest): string {
  const xff = req.headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : xff
  if (raw) {
    const first = raw.split(',')[0]?.trim()
    if (first) return first
  }
  return req.ip ?? 'unknown'
}
