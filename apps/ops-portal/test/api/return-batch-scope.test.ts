import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApiClient } from '../../src/api/client.js'
import { commitReturnUpload } from '../../src/api/endpoints.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// THE BATCH ID HAS TO REACH THE SERVER (19 Aug 2026).
//
// The batch-scoped return page promises "every Dispatch ID in the file must
// belong to this batch; a row from any other batch refuses the whole sheet", and
// until this change that promise was kept ONLY in the browser, by a disabled
// Commit button. The server never saw the batch, so its own cross-batch defence
// was mixed_vendors, which under single-partner scope (D-9a: exactly one ACTIVE
// PRINT vendor) can never fire.
//
// The domain guard is covered where it lives, in
// services/fulfillment/test/return-sheet.test.ts. THIS pins the seam that guard
// depends on: that the id is actually put on the wire, and that it is left off
// when there is no batch in hand. A silent regression here would restore the
// cosmetic version of the promise with every domain test still green.

function stubOk(): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ pairedUnitIds: [], quarantined: 0, shptIds: [], collateralLinked: 0, deduped: false, invalidRows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return calls
}

function sheet(): File {
  return new File(['Dispatch ID,Device ID,AWB\n'], 'return.csv', { type: 'text/csv' })
}

/** The real client shape, so this exercises the same path the portal does. */
function newClient() {
  return createApiClient({
    opsBase: 'http://ops',
    authBase: 'http://auth',
    onSessionLost: vi.fn(),
    promptStepUpTotp: vi.fn(),
  })
}

/** The multipart body as sent, so the assertion reads the wire and not our own call. */
function fields(init: RequestInit): FormData {
  expect(init.body).toBeInstanceOf(FormData)
  return init.body as FormData
}

describe('commitReturnUpload carries the batch scope', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    clearAccessToken()
  })

  it('sends batchId when the upload came from a batch', async () => {
    const calls = stubOk()
    const client = newClient()
    await commitReturnUpload(client, sheet(), 'idem-1', 'btch_01m0b4havzf85vmp6zpmpq5m3f')

    const form = fields(calls[0]!.init)
    expect(form.get('batchId')).toBe('btch_01m0b4havzf85vmp6zpmpq5m3f')
    // The file is still the file: the extra field must not displace it.
    expect(form.get('file')).toBeInstanceOf(File)
  })

  it('omits batchId entirely for the generic Uploads entry', async () => {
    const calls = stubOk()
    const client = newClient()
    await commitReturnUpload(client, sheet(), 'idem-2')

    // ABSENT, not empty string: the edge treats an absent field as "no batch in
    // hand" and an empty one the same way, but sending nothing is what keeps the
    // unscoped path byte-identical to its pre-change behaviour.
    expect(fields(calls[0]!.init).has('batchId')).toBe(false)
  })

  it('treats an empty batch id as no batch rather than as an unmatchable one', async () => {
    // A '' would resolve to no batch and come back foreign_dispatch, blaming the
    // sheet for what is really a missing query parameter.
    const calls = stubOk()
    const client = newClient()
    await commitReturnUpload(client, sheet(), 'idem-3', '')

    expect(fields(calls[0]!.init).has('batchId')).toBe(false)
  })
})
