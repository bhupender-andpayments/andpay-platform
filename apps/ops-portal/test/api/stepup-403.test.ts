import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { newIdempotencyKey } from '../../src/api/idempotency.js'

function seqFetch(seq: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init }); const r = seq[i++]
    if (!r) throw new Error(`seqFetch: no scripted response for call ${i}`)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }))
  return { calls }
}

describe('403 step-up interceptor', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })

  it('a 403 on a step-up-gated action prompts TOTP, steps up, retries ONCE with the same idempotency key', async () => {
    setAccessToken('t0')
    const key = newIdempotencyKey()
    const { calls } = seqFetch([
      { status: 403 },                                  // override attempt
      { status: 200, body: { accessToken: 't1' } },     // stepup mint
      { status: 200, body: { deduped: false, overridden: true } }, // retry
    ])
    const promptStepUpTotp = vi.fn(async () => '123456')
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost: vi.fn(), promptStepUpTotp })
    const out = await c.request({ method: 'POST', path: '/ops/shipments/s1/override', idempotencyKey: key, stepUpKey: 'terminal-override', body: { status: 'DELIVERED', courierTimestamp: 't', overrideReason: 'r' } })
    expect(out).toMatchObject({ overridden: true })
    expect(promptStepUpTotp).toHaveBeenCalledOnce()
    expect(calls[1]!.url).toBe('http://auth/session/stepup')
    // same idempotency key on the retry as the original
    expect((calls[0]!.init.headers as Record<string,string>)['Idempotency-Key']).toBe(key)
    expect((calls[2]!.init.headers as Record<string,string>)['Idempotency-Key']).toBe(key)
  })

  it('a cancelled TOTP prompt surfaces the 403 and does not call stepup', async () => {
    setAccessToken('t0')
    const { calls } = seqFetch([{ status: 403 }])
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost: vi.fn(), promptStepUpTotp: vi.fn(async () => null) })
    await expect(c.request({ method: 'POST', path: '/ops/records/a1/release', idempotencyKey: 'k', stepUpKey: 'hold-release' })).rejects.toMatchObject({ status: 403 })
    expect(calls.length).toBe(1)
  })

  it('a 403 that still 403s after step-up surfaces and does not loop', async () => {
    setAccessToken('t0')
    const { calls } = seqFetch([
      { status: 403 }, { status: 200, body: { accessToken: 't1' } }, { status: 403 },
    ])
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost: vi.fn(), promptStepUpTotp: vi.fn(async () => '000000') })
    await expect(c.request({ method: 'POST', path: '/ops/vendors/v1/suspend', idempotencyKey: 'k', stepUpKey: 'vendor-suspend' })).rejects.toMatchObject({ status: 403 })
    expect(calls.length).toBe(3) // no fourth call
  })

  it('a 403 on a NON-step-up action surfaces directly (no prompt)', async () => {
    setAccessToken('t0')
    const promptStepUpTotp = vi.fn()
    seqFetch([{ status: 403 }])
    const c = createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost: vi.fn(), promptStepUpTotp })
    await expect(c.request({ method: 'POST', path: '/ops/batches/trigger', idempotencyKey: 'k' })).rejects.toMatchObject({ status: 403 })
    expect(promptStepUpTotp).not.toHaveBeenCalled()
  })
})
