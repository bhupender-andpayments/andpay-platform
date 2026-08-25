import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { fetchAggregatorLogoDerivative, fetchAggregatorLogoVersionMaster } from '../../src/api/endpoints.js'

// The logo thumbnail and per-version preview used raw fetch with a Bearer and
// therefore no refresh-on-401-and-retry. Ten minutes after the last refresh,
// every thumbnail on the Bank Masters page decayed to "unavailable" while the
// typed calls on the same page kept working, because a passive render has no
// button to click again. Found by driving the live portal, 21 Aug 2026. These
// tests pin the fix: the binary paths ride the client's interceptor.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function seqFetch(seq: Array<{ status: number; body?: unknown; bytes?: Uint8Array }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = seq[i++]
    if (!r) throw new Error(`seqFetch: no scripted response for call ${i}`)
    if (r.bytes !== undefined) {
      return new Response(r.bytes.slice().buffer, { status: r.status, headers: { 'content-type': 'image/png' } })
    }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return { calls }
}

function client(onSessionLost = vi.fn()) {
  return createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost, promptStepUpTotp: vi.fn() })
}

describe('binary responses through the 401 interceptor', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })

  it('a blob request that 401s refreshes once, retries, and returns the bytes', async () => {
    setAccessToken('stale')
    const { calls } = seqFetch([
      { status: 401 },                                  // derivative, stale token
      { status: 200, body: { accessToken: 'fresh' } },  // refresh
      { status: 200, bytes: PNG },                      // retry succeeds
    ])
    const blob = await fetchAggregatorLogoDerivative(client(), 'aggr_x')
    expect(blob).not.toBeNull()
    // jsdom's Blob has no arrayBuffer(); the byte count is assertion enough
    // that the retry's 200 body (not the 401's empty one) is what came back.
    expect(blob!.size).toBe(PNG.byteLength)
    expect(calls[1]!.url).toBe('http://auth/session/refresh')
    expect((calls[2]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer fresh')
  })

  it('a 404 stays a real answer (no logo yet): null, no refresh fired', async () => {
    setAccessToken('valid')
    const { calls } = seqFetch([{ status: 404 }])
    const blob = await fetchAggregatorLogoDerivative(client(), 'aggr_x')
    expect(blob).toBeNull()
    expect(calls.length).toBe(1)
  })

  it('the per-version master rides the same interceptor', async () => {
    setAccessToken('stale')
    const { calls } = seqFetch([
      { status: 401 },
      { status: 200, body: { accessToken: 'fresh' } },
      { status: 200, bytes: PNG },
    ])
    const blob = await fetchAggregatorLogoVersionMaster(client(), 'aggr_x', 'v1')
    expect(blob).not.toBeNull()
    expect(calls[0]!.url).toBe('http://ops/ops/aggregators/aggr_x/logo/versions/v1/master')
    expect(calls[2]!.url).toBe(calls[0]!.url)
  })

  it('a non-2xx blob request still surfaces a parsed error body, not a Blob', async () => {
    setAccessToken('valid')
    seqFetch([
      { status: 500, body: { message: 'boom' } },
    ])
    await expect(fetchAggregatorLogoDerivative(client(), 'aggr_x')).rejects.toMatchObject({
      status: 500,
      body: { message: 'boom' },
    })
  })
})
