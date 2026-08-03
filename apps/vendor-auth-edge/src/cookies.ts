// The vendor refresh-token cookie transport (spec 14a task 8, mirrors
// apps/auth-edge/src/cookies.ts check 5). The refresh token is a
// browser-opaque, HttpOnly cookie scoped to the vendor-auth refresh PATH only
// (`Path=/session`), so it is never readable by page JavaScript and is only
// re-presented on the /session/* routes that rotate or revoke it. The access
// token, by contrast, is returned in the JSON body ONLY (never a cookie,
// never instructed into localStorage): the two transports are deliberately
// split so an XSS payload cannot read the refresh token and the access token
// is never silently re-sent on cross-site navigations.
//
// The cookie NAME is deliberately distinct from apps/auth-edge's
// `andpay_rt` (`andpay_vendor_rt`): this edge runs as its own process behind
// its own origin (`vendorPortalOrigin`, distinct from the internal
// `portalOrigin`), so a browser that somehow held sessions against both edges
// on the same registrable domain would never confuse the two refresh cookies.
//
// The Set-Cookie string is built explicitly here (no cookie-parser / no
// cookie-serializer dependency): the flags are a fixed, security-critical set
// and are asserted verbatim by a future task's test, so hand-building the
// string keeps them visible and un-negotiable.
export const VENDOR_REFRESH_COOKIE_NAME = 'andpay_vendor_rt'

// SameSite=Strict: the refresh cookie is NEVER sent on any cross-site request,
// so a third-party page cannot trigger a silent refresh. Secure: HTTPS only.
// HttpOnly: unreadable by page script. Path=/session: presented only on the
// refresh/logout family, never on unrelated same-origin routes.
export function serializeVendorRefreshCookie(token: string, absoluteSec: number): string {
  return `${VENDOR_REFRESH_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/session; Max-Age=${absoluteSec}`
}

// The logout / rotation-clear counterpart (used by the login/refresh/logout
// controllers of Tasks 9 to 12): the same name, path, and flags with an empty
// value and Max-Age=0, so the browser drops the cookie. The flags MUST match
// serializeVendorRefreshCookie exactly or the browser treats it as a
// different cookie and refuses to clear it.
export function clearVendorRefreshCookie(): string {
  return `${VENDOR_REFRESH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/session; Max-Age=0`
}
