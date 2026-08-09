// The refresh-token cookie transport (spec 12 task 9, check 5). The refresh
// token is a browser-opaque, HttpOnly cookie scoped to the refresh PATH only
// (`Path=/session`), so it is never readable by page JavaScript and is only
// re-presented on the /session/* routes that rotate or revoke it. The access
// token, by contrast, is returned in the JSON body ONLY (never a cookie,
// never instructed into localStorage): the two transports are deliberately
// split so an XSS payload cannot read the refresh token and the access token
// is never silently re-sent on cross-site navigations.
//
// The Set-Cookie string is built explicitly here (no cookie-parser / no
// cookie-serializer dependency): the flags are a fixed, security-critical set
// and are asserted verbatim by the task-9 test, so hand-building the string
// keeps them visible and un-negotiable.
export const REFRESH_COOKIE_NAME = 'andpay_rt'

// `Secure` is the ONLY negotiable flag here, and it defaults to on.
//
// WHY IT HAD TO BECOME NEGOTIABLE. A `Secure` cookie may only be stored and
// re-sent over HTTPS. Over plain http:// a conforming client accepts the
// response, DISCARDS the cookie, and says nothing. The local demo harness
// serves the edges over http://localhost, so the refresh cookie was thrown away
// at every login and every /session/refresh arrived with no cookie at all and
// answered 401. The visible symptom was an operator being signed out a few
// minutes after logging in, every time, with the 10-minute access token as the
// real clock: silent renewal had never worked once.
//
// Proven rather than reasoned: `curl -c` against the running demo produced an
// EMPTY cookie jar from a 200 login whose response carried a correct
// Set-Cookie, because curl honours `Secure` strictly.
//
// PRODUCTION IS UNCHANGED AND MUST STAY THAT WAY. The default is `true`, so
// every caller that does not think about it gets the secure cookie. Only a
// deployment that KNOWS it is serving plain http, which in practice means the
// local harness, passes false. Anything reachable off the machine is behind TLS
// and has no business setting this.
export interface RefreshCookieOptions {
  /** Defaults to true. False ONLY for a local http:// dev harness. */
  secure?: boolean
}

function flags({ secure = true }: RefreshCookieOptions = {}): string {
  // SameSite=Strict: the refresh cookie is NEVER sent on any cross-site
  // request, so a third-party page cannot trigger a silent refresh. HttpOnly:
  // unreadable by page script. Path=/session: presented only on the
  // refresh/logout family, never on unrelated same-origin routes. None of
  // those three are configurable.
  return `HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/session`
}

export function serializeRefreshCookie(
  token: string,
  absoluteSec: number,
  options: RefreshCookieOptions = {},
): string {
  return `${REFRESH_COOKIE_NAME}=${token}; ${flags(options)}; Max-Age=${absoluteSec}`
}

// The logout / rotation-clear counterpart (used by Tasks 10 to 11): the same
// name, path, and flags with an empty value and Max-Age=0, so the browser
// drops the cookie. The flags MUST match serializeRefreshCookie exactly or the
// browser treats it as a different cookie and refuses to clear it, which is
// why both go through `flags()` and why `secure` has to be passed to BOTH.
export function clearRefreshCookie(options: RefreshCookieOptions = {}): string {
  return `${REFRESH_COOKIE_NAME}=; ${flags(options)}; Max-Age=0`
}
