// The access token lives ONLY here, in a module closure (spec-12 transport):
// never localStorage, never sessionStorage, never a JS-readable cookie. The
// refresh token is the httpOnly cookie the browser manages and the SPA cannot
// read. Cleared on logout and on an unrecoverable session loss.
let accessToken: string | null = null
export function getAccessToken(): string | null { return accessToken }
export function setAccessToken(t: string | null): void { accessToken = t }
export function clearAccessToken(): void { accessToken = null }
