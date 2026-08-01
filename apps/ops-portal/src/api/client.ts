import { getAccessToken } from './tokenStore.js'
import { ApiError } from './errors.js'
import type { OpsStepUpKey } from '@andpay/authz/stepup-operations'

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
  async function request<T>(req: ApiRequest): Promise<T> {
    const r = await sendOnce(deps, req)
    if (r.status >= 200 && r.status < 300) return r.data as T
    throw new ApiError(r.status, r.data)
  }
  return { request }
}
