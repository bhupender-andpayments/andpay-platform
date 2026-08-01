import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { setAccessToken, clearAccessToken, getAccessToken } from '../../src/api/tokenStore.js'

// sequenced fetch: each call returns the next scripted response
function seqFetch(seq: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = seq[i++]
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }))
  return { calls }
}

describe('401 interceptor', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })

  it('a 401 triggers ONE refresh, swaps the token, retries once, succeeds', async () => {
    setAccessToken('stale')
    const { calls } = seqFetch([
      { status: 401 },                              // original ops call
      { status: 200, body: { accessToken: 'fresh' } }, // refresh
      { status: 200, body: { rows: [] } },          // retry
    ])
    const onSessionLost = vi.fn()
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost, promptStepUpTotp: vi.fn() })
    const out = await c.request<{ rows: unknown[] }>({ method: 'GET', path: '/ops/quarantine' })
    expect(out).toEqual({ rows: [] })
    expect(calls[1].url).toBe('http://auth/session/refresh')
    expect(calls[1].init.credentials).toBe('include')
    expect(getAccessToken()).toBe('fresh')
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('a second 401 after refresh routes to login and throws', async () => {
    setAccessToken('stale')
    seqFetch([
      { status: 401 },                               // original
      { status: 200, body: { accessToken: 'fresh' } },  // refresh ok
      { status: 401 },                               // retry still 401
    ])
    const onSessionLost = vi.fn()
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost, promptStepUpTotp: vi.fn() })
    await expect(c.request({ method: 'GET', path: '/ops/quarantine' })).rejects.toBeTruthy()
    expect(onSessionLost).toHaveBeenCalledOnce()
  })

  it('a failed refresh (401) routes to login and does not retry', async () => {
    setAccessToken('stale')
    const { calls } = seqFetch([{ status: 401 }, { status: 401 }])
    const onSessionLost = vi.fn()
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost, promptStepUpTotp: vi.fn() })
    await expect(c.request({ method: 'GET', path: '/ops/quarantine' })).rejects.toBeTruthy()
    expect(calls.length).toBe(2) // original + refresh, NO third retry
    expect(onSessionLost).toHaveBeenCalledOnce()
  })
})
