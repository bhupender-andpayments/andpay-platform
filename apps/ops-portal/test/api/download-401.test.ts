import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { downloadDispatchExcel, downloadCollateral } from '../../src/api/endpoints.js'
import { setAccessToken, clearAccessToken, getAccessToken } from '../../src/api/tokenStore.js'

// THE DOWNLOAD ROUTES, SAME DEFECT AS THE UPLOADS (see upload-401.test.ts).
//
// Both of these called `fetch` directly with a hand-built Bearer header, so
// like the multipart uploads they never got client.ts's refresh-on-401-and-
// retry. With accessTtlSec 600 that means a collateral or dispatch-excel
// download fails about ten minutes after the last refresh, which is precisely
// the stage of the walkthrough where an operator reaches for them.
//
// They are NOT a rename of the upload fix: a download needs the response BODY
// as a Blob and the FILENAME out of Content-Disposition, and `request()`
// returns only the parsed body. Hence responseType 'blob' plus a result-
// returning entry point that keeps the headers.
//
// The 404-is-null contract on collateral is behaviour worth pinning: the edge
// returns 404 deliberately when a batch has no artifact of that type, so it
// must stay a real outcome and must never be mistaken for a session problem.

interface Scripted {
  status: number
  json?: unknown
  blobText?: string
  filename?: string
}

function seqFetch(seq: Scripted[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = seq[i++]
    if (!r) throw new Error(`seqFetch: no scripted response for call ${i}`)
    if (r.blobText !== undefined) {
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
      if (r.filename !== undefined) headers['Content-Disposition'] = `attachment; filename="${r.filename}"`
      // The body is passed as a plain string, NOT wrapped in a Blob: jsdom's
      // Blob is not a BodyInit the Response constructor understands, so
      // wrapping it stringifies to the literal "[object Blob]". The code under
      // test calls res.blob() itself, which is what is being exercised.
      return new Response(r.blobText, { status: r.status, headers })
    }
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
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

describe('binary downloads and the 401 interceptor', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })

  it('a dispatch-excel download refreshes on 401 and retries, returning the file', async () => {
    setAccessToken('stale')
    const { calls } = seqFetch([
      { status: 401, json: {} },
      { status: 200, json: { accessToken: 'fresh' } },
      { status: 200, blobText: 'XLSX-BYTES', filename: 'dispatch-btch_1.xlsx' },
    ])
    const { c, onSessionLost } = client()

    const out = await downloadDispatchExcel(c, 'btch_1')

    // A real Blob carrying the whole body, rather than a parsed-JSON one,
    // which is exactly what responseType 'blob' exists to produce. jsdom's
    // Blob has no .text(), so size is the readable proof the bytes survived.
    expect(out.blob).toBeInstanceOf(Blob)
    expect(out.blob.size).toBe('XLSX-BYTES'.length)
    expect(calls.length).toBe(3)
    expect(calls[1]!.url).toBe('http://auth/session/refresh')
    expect(getAccessToken()).toBe('fresh')
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('takes the filename from Content-Disposition, so headers survive the client', async () => {
    setAccessToken('tok')
    seqFetch([{ status: 200, blobText: 'PDF', filename: 'qr-btch_9.pdf' }])
    const { c } = client()

    const out = await downloadCollateral(c, 'btch_9', 'qr')

    expect(out).not.toBeNull()
    expect(out!.filename).toBe('qr-btch_9.pdf')
  })

  it('falls back to a derived filename when the header is absent', async () => {
    setAccessToken('tok')
    seqFetch([{ status: 200, blobText: 'XLSX' }])
    const { c } = client()

    const out = await downloadDispatchExcel(c, 'btch_2')

    expect(out.filename).toBe('dispatch-btch_2.xlsx')
  })

  it('a 404 collateral is null, not an error, and never looks like a lost session', async () => {
    setAccessToken('tok')
    const { c, onSessionLost } = client()
    const { calls } = seqFetch([{ status: 404, json: {} }])

    const out = await downloadCollateral(c, 'btch_1', 'standee')

    expect(out).toBeNull()
    expect(onSessionLost).not.toHaveBeenCalled()
    expect(calls.length).toBe(1) // no refresh attempt: 404 is not 401
  })

  it('never sends the literal string "Bearer null" when no token is held', async () => {
    clearAccessToken()
    const { calls } = seqFetch([{ status: 200, blobText: 'PDF', filename: 'x.pdf' }])
    const { c } = client()

    await downloadCollateral(c, 'btch_1', 'qr')

    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).not.toBe('Bearer null')
  })
})
