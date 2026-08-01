import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { newIdempotencyKey } from '../../src/api/idempotency.js'

function mockFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses[Math.min(i++, responses.length - 1)]!
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    })
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

const deps = { opsBase: 'http://ops', authBase: 'http://auth', onSessionLost: vi.fn(), promptStepUpTotp: vi.fn() }

describe('api client core', () => {
  beforeEach(() => { clearAccessToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); deps.onSessionLost = vi.fn() })

  it('attaches the in-memory Bearer to ops calls and returns parsed JSON', async () => {
    setAccessToken('tok-1')
    const { calls } = mockFetch([{ status: 200, body: { ok: true } }])
    const c = createApiClient(deps)
    const out = await c.request<{ ok: boolean }>({ method: 'GET', path: '/ops/vendors' })
    expect(out).toEqual({ ok: true })
    expect(calls[0]!.url).toBe('http://ops/ops/vendors')
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-1')
  })

  it('sends the Idempotency-Key header on writes and never on the auth cookie path', async () => {
    setAccessToken('tok-1')
    const key = newIdempotencyKey()
    const { calls } = mockFetch([{ status: 200, body: {} }])
    const c = createApiClient(deps)
    await c.request({ method: 'POST', path: '/ops/batches/trigger', idempotencyKey: key })
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(key)
    expect(calls[0]!.init.credentials).toBeUndefined()
  })

  it('uses credentials:include only on the auth base', async () => {
    const { calls } = mockFetch([{ status: 200, body: { accessToken: 'x' } }])
    const c = createApiClient(deps)
    await c.request({ method: 'POST', path: '/session/login', base: 'auth', withCookie: true, body: { u: 1 } })
    expect(calls[0]!.url).toBe('http://auth/session/login')
    expect(calls[0]!.init.credentials).toBe('include')
  })

  it('throws ApiError with status and body on a non-2xx', async () => {
    setAccessToken('tok-1')
    mockFetch([{ status: 400, body: { code: 'invalid' } }])
    const c = createApiClient(deps)
    await expect(c.request({ method: 'GET', path: '/ops/vendors' })).rejects.toMatchObject({ status: 400 })
  })
})
