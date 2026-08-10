import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { previewBank } from '../../src/api/endpoints.js'
import { setAccessToken, clearAccessToken, getAccessToken } from '../../src/api/tokenStore.js'

// THE UPLOAD ROUTES MUST OBEY THE 401 INTERCEPTOR LIKE EVERY OTHER CALL.
//
// Found by driving the real system: a bank file would not save. The audit
// ledger (auth.authz_audit) held an ALLOW for ops:upload-device-inventory and
// then NO ops:upload-bank-file entry at all, only `authenticate` DENYs with
// reason token-verify-failed. The upload never reached the authorization gate,
// so nothing could persist, and the file itself audited 360 rows / 360 valid.
//
// The cause was that postFile called `fetch` DIRECTLY instead of going through
// the client, so it skipped the refresh-on-401-and-retry in client.ts. With
// accessTtlSec 600 in the harness, that makes every upload fail roughly ten
// minutes after the last refresh. The device-inventory upload only ever
// succeeded because it happened 21 seconds after login.
//
// It also interpolated `Bearer ${getAccessToken()}` with no null check, and
// client.ts sets the token to null after a failed refresh, so a later upload
// sent the literal string "Bearer null".
//
// These pin the behaviour at the seam that was missing, not at postFile's
// internals, so the fix stays free to be "route it through the client".

function seqFetch(seq: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = seq[i++]
    if (!r) throw new Error(`seqFetch: no scripted response for call ${i}`)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return { calls }
}

function client(onSessionLost = vi.fn()) {
  return {
    c: createApiClient({ opsBase: 'http://ops', authBase: 'http://auth', onSessionLost, promptStepUpTotp: vi.fn() }),
    onSessionLost,
  }
}

const EMPTY_PREVIEW = { rows: [], structuralErrors: [] }

function bankFile() {
  return new File(['Business Name,VPA\nx,y@z\n'], 'bank.csv', { type: 'text/csv' })
}

describe('multipart uploads and the 401 interceptor', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })

  it('an upload refreshes on 401 and retries, carrying the file again', async () => {
    setAccessToken('stale')
    const { calls } = seqFetch([
      { status: 401 },                                  // upload with the expired token
      { status: 200, body: { accessToken: 'fresh' } },  // refresh
      { status: 200, body: EMPTY_PREVIEW },             // retried upload
    ])
    const { c, onSessionLost } = client()

    const out = await previewBank(c, bankFile())

    expect(out).toEqual(EMPTY_PREVIEW)
    expect(calls.length).toBe(3)
    expect(calls[1]!.url).toBe('http://auth/session/refresh')
    expect(getAccessToken()).toBe('fresh')
    expect(onSessionLost).not.toHaveBeenCalled()
    // The retry has to resend the FILE, not an empty body. A retry that drops
    // the multipart payload would 400 and look like a different bug.
    const retried = calls[2]!.init.body
    expect(retried).toBeInstanceOf(FormData)
    expect((retried as FormData).get('file')).toBeInstanceOf(File)
  })

  it('does not force a JSON Content-Type on a multipart body', async () => {
    // The browser must set Content-Type itself: it carries the multipart
    // boundary, and a hand-set application/json makes the edge reject the file.
    setAccessToken('tok')
    const { calls } = seqFetch([{ status: 200, body: EMPTY_PREVIEW }])
    const { c } = client()

    await previewBank(c, bankFile())

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('never sends the literal string "Bearer null" when no token is held', async () => {
    clearAccessToken()
    const { calls } = seqFetch([{ status: 200, body: EMPTY_PREVIEW }])
    const { c } = client()

    await previewBank(c, bankFile())

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).not.toBe('Bearer null')
  })
})
