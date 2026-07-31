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

// SameSite=Strict: the refresh cookie is NEVER sent on any cross-site request,
// so a third-party page cannot trigger a silent refresh. Secure: HTTPS only.
// HttpOnly: unreadable by page script. Path=/session: presented only on the
// refresh/logout family, never on unrelated same-origin routes.
export function serializeRefreshCookie(token: string, absoluteSec: number): string {
  return `${REFRESH_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/session; Max-Age=${absoluteSec}`
}

// The logout / rotation-clear counterpart (used by Tasks 10 to 11): the same
// name, path, and flags with an empty value and Max-Age=0, so the browser
// drops the cookie. The flags MUST match serializeRefreshCookie exactly or the
// browser treats it as a different cookie and refuses to clear it.
export function clearRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/session; Max-Age=0`
}
