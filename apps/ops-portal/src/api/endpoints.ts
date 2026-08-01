import type { ApiRequest } from './client.js'

type Client = { request<T>(req: ApiRequest): Promise<T> }

// The real /session/login contract (apps/auth-edge/src/login.controller.ts):
// body is { handle, password, totp } and the response is ONLY { accessToken }.
// There is no principal object on the wire; the caller derives a display
// principal by decoding the token itself (see AuthContext.decodeTokenClaims).
export function login(c: Client, body: { handle: string; password: string; totp: string }) {
  return c.request<{ accessToken: string }>({
    method: 'POST',
    path: '/session/login',
    base: 'auth',
    withCookie: true,
    body,
  })
}

// /session/logout (apps/auth-edge/src/session.controller.ts) is a 204 with no
// body; it revokes the refresh-token family and clears the refresh cookie.
export function logout(c: Client) {
  return c.request<void>({ method: 'POST', path: '/session/logout', base: 'auth', withCookie: true })
}
