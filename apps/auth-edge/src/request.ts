import { REFRESH_COOKIE_NAME } from './cookies.js'

// Request-side helpers shared by the login/refresh/logout controllers. Kept
// dependency-free (no cookie-parser): the ONE cookie this edge reads is the
// refresh cookie, so a tiny hand-rolled parser over the raw Cookie header is
// both smaller and easier to reason about than a general cookie library.

// Parses the `andpay_rt` value out of a raw `Cookie` request header. Returns
// undefined when the header is absent or the cookie is not present. Values are
// URL-safe base64url refresh tokens (no `=`/`;`/`,` inside), so a simple
// split on `;` and `=` is sufficient and unambiguous.
export function readRefreshCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === REFRESH_COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return undefined
}

// The minimal request shape sourceKey reads. Kept structural (not the full
// express Request) so this helper stays testable and framework-light.
interface ThrottleSourceRequest {
  headers: Record<string, string | string[] | undefined>
  ip?: string
}

// The 6d throttle source key (used by Task 12's real bucket). Behind a trusted
// reverse proxy the client IP is the FIRST hop of X-Forwarded-For (the proxy
// appends its own address to the right); absent that header, the socket peer
// (`req.ip`) is used. Returns 'unknown' only if neither is present, so the
// bucket always has a stable key to charge.
export function sourceKey(req: ThrottleSourceRequest): string {
  const xff = req.headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : xff
  if (raw) {
    const first = raw.split(',')[0]?.trim()
    if (first) return first
  }
  return req.ip ?? 'unknown'
}
