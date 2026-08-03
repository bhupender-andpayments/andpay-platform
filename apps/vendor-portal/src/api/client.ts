import { getAccessToken, setAccessToken } from './tokenStore.js'
import { ApiError } from './errors.js'

export interface ApiClientDeps {
  vendorBase: string
  authBase: string
  onSessionLost(): void
}

export interface ApiRequest {
  method: string
  path: string
  base?: 'vendor' | 'auth'
  body?: unknown
  idempotencyKey?: string
  withCookie?: boolean
  // default 'json' parses the body with JSON.parse. 'text' skips JSON.parse
  // and returns the raw response text, for a text/csv (or similar) body that
  // is not valid JSON. Nothing else in sendOnce or attempt branches on this.
  responseType?: 'json' | 'text'
}

export interface ApiResult {
  status: number
  headers: Headers
  data: unknown
}

// Assemble one HTTP attempt: base url, Bearer attach (vendor base, plus the
// auth base when a token is already held, for refresh CSRF binding),
// Idempotency-Key (writes), credentials:include (auth cookie path only).
// Returns the raw result so the 401 interceptor (below) can branch on status
// before the caller sees it. NO step-up here: the vendor portal has no
// destructive actions, so there is no 403/step-up branch at all.
export async function sendOnce(deps: ApiClientDeps, req: ApiRequest): Promise<ApiResult> {
  const base = req.base === 'auth' ? deps.authBase : deps.vendorBase
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (req.base !== 'auth') {
    const tok = getAccessToken()
    if (tok !== null) headers['Authorization'] = `Bearer ${tok}`
  } else if (getAccessToken() !== null) {
    // The auth cookie path still presents the current access token as the
    // Bearer for /session/refresh CSRF binding.
    headers['Authorization'] = `Bearer ${getAccessToken()!}`
  }
  if (req.idempotencyKey !== undefined) headers['Idempotency-Key'] = req.idempotencyKey
  if (req.body !== undefined) headers['Content-Type'] = 'application/json'
  const init: RequestInit = {
    method: req.method,
    headers,
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    ...(req.withCookie ? { credentials: 'include' } : {}),
  }
  const res = await fetch(`${base}${req.path}`, init)
  const text = await res.text()
  const data = req.responseType === 'text' ? text : text === '' ? null : JSON.parse(text)
  return { status: res.status, headers: res.headers, data }
}

export function createApiClient(deps: ApiClientDeps) {
  // Refresh once on a 401. `alreadyRefreshed` bounds the interceptor to a
  // single attempt per logical request so a persistently-failing backend
  // cannot loop.
  async function attempt<T>(req: ApiRequest, alreadyRefreshed: boolean): Promise<T> {
    const r = await sendOnce(deps, req)
    if (r.status >= 200 && r.status < 300) return r.data as T

    if (r.status === 401 && req.base !== 'auth') {
      if (!alreadyRefreshed) {
        const refreshed = await sendOnce(deps, { method: 'POST', path: '/session/refresh', base: 'auth', withCookie: true })
        if (refreshed.status >= 200 && refreshed.status < 300) {
          const tok = (refreshed.data as { accessToken?: string }).accessToken
          if (typeof tok === 'string') { setAccessToken(tok); return attempt<T>(req, true) }
        }
      }
      // Either the refresh itself failed, or this is a retry that still got a
      // 401 (post-refresh 401): one refresh attempt is all we get either way.
      setAccessToken(null)
      deps.onSessionLost()
      throw new ApiError(401, r.data)
    }

    throw new ApiError(r.status, r.data)
  }
  return { request: <T>(req: ApiRequest) => attempt<T>(req, false) }
}
