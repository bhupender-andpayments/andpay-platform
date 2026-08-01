import { getAccessToken, setAccessToken } from './tokenStore.js'
import { ApiError } from './errors.js'
import { OPS_STEP_UP_GATED_OPERATIONS, type OpsStepUpKey } from '@andpay/authz/stepup-operations'

export interface ApiClientDeps {
  opsBase: string
  authBase: string
  onSessionLost(): void
  promptStepUpTotp(): Promise<string | null>
}

export interface ApiRequest {
  method: string
  path: string
  base?: 'ops' | 'auth'
  body?: unknown
  idempotencyKey?: string
  stepUpKey?: OpsStepUpKey
  withCookie?: boolean
}

export interface ApiResult {
  status: number
  headers: Headers
  data: unknown
}

// Assemble one HTTP attempt: base url, Bearer attach (ops only), Idempotency-Key
// (writes), credentials:include (auth cookie path only). Returns the raw result
// so the interceptors (Tasks 5, 6) can branch on status before the caller sees it.
export async function sendOnce(deps: ApiClientDeps, req: ApiRequest): Promise<ApiResult> {
  const base = req.base === 'auth' ? deps.authBase : deps.opsBase
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (req.base !== 'auth') {
    const tok = getAccessToken()
    if (tok !== null) headers['Authorization'] = `Bearer ${tok}`
  } else if (getAccessToken() !== null) {
    // The auth cookie path still presents the current access token as the Bearer
    // for /session/refresh CSRF binding and /session/stepup elevation.
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
  const data = text === '' ? null : JSON.parse(text)
  return { status: res.status, headers: res.headers, data }
}

export function createApiClient(deps: ApiClientDeps) {
  // Refresh once on a 401, step up once on a gated 403. `alreadyRefreshed` and
  // `alreadySteppedUp` each bound their own interceptor to a single attempt per
  // logical request so a persistently-failing backend cannot loop.
  async function attempt<T>(req: ApiRequest, alreadyRefreshed: boolean, alreadySteppedUp: boolean): Promise<T> {
    const r = await sendOnce(deps, req)
    if (r.status >= 200 && r.status < 300) return r.data as T

    if (r.status === 401 && req.base !== 'auth') {
      if (!alreadyRefreshed) {
        const refreshed = await sendOnce(deps, { method: 'POST', path: '/session/refresh', base: 'auth', withCookie: true })
        if (refreshed.status >= 200 && refreshed.status < 300) {
          const tok = (refreshed.data as { accessToken?: string }).accessToken
          if (typeof tok === 'string') { setAccessToken(tok); return attempt<T>(req, true, alreadySteppedUp) }
        }
      }
      // Either the refresh itself failed, or this is a retry that still got a
      // 401 (post-refresh 401): one refresh attempt is all we get either way.
      setAccessToken(null)
      deps.onSessionLost()
      throw new ApiError(401, r.data)
    }

    // Reactive step-up: only for actions the browser-safe catalog (imported
    // above, NOT the requireStepUp/meetsAcr evaluator, S24/T14) marks gated,
    // and only once per logical request. A cancelled prompt, a step-up DENY,
    // or a still-403 retry all surface without looping.
    if (
      r.status === 403 &&
      !alreadySteppedUp &&
      req.stepUpKey !== undefined &&
      OPS_STEP_UP_GATED_OPERATIONS.includes(req.stepUpKey)
    ) {
      const totp = await deps.promptStepUpTotp()
      if (totp === null) throw new ApiError(403, r.data) // cancelled: surface, no loop
      const minted = await sendOnce(deps, { method: 'POST', path: '/session/stepup', base: 'auth', withCookie: true, body: { totp } })
      if (minted.status >= 200 && minted.status < 300) {
        const tok = (minted.data as { accessToken?: string }).accessToken
        if (typeof tok === 'string') { setAccessToken(tok); return attempt<T>(req, alreadyRefreshed, true) }
      }
      throw new ApiError(403, r.data) // step-up DENY, or a still-403 retry: surface, no loop
    }

    throw new ApiError(r.status, r.data)
  }
  return { request: <T>(req: ApiRequest) => attempt<T>(req, false, false) }
}
