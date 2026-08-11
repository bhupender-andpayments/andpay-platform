import { useEffect } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { ReturnUploadPage } from '../../src/features/returns/ReturnUploadPage.js'
import { clearAccessToken } from '../../src/api/tokenStore.js'

// The GROUNDED return-upload contract (task 14 brief, verified against
// apps/vendor-edge/src/return.controller.ts and sheet-parse.ts):
//   POST /vendor/return is MULTIPART (FileInterceptor('file')), body is a
//   `file` part whose content is the ReturnSheet JSON string
//   `{ fileId, vndrId, workQueue, rows }`, rows EXACTLY
//   `{ deviceSerial, asgnId, awb, courierCode? }`. vndrId MUST be the
//   operator's own token scope.vndr, never a caller-supplied value.

function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
}

// No Nav/routing wraps ReturnUploadPage yet (a later task): this harness
// logs in via the real AuthContext.login flow (so principal.vndr is
// genuinely decoded from a token, never injected directly) and renders the
// page once the principal is set.
function Harness() {
  const { principal, login } = useAuth()
  useEffect(() => {
    if (principal === null) {
      void login({ handle: 'alice', password: 'pw', totp: '123456' })
    }
  }, [principal, login])
  if (principal === null) return <p>loading</p>
  return <ReturnUploadPage />
}

function renderHarness() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Harness />
      </AuthProvider>
    </MemoryRouter>,
  )
}

interface Call {
  url: string
  init: RequestInit
}

const OPERATOR_VNDR = 'vndr_abc123'
const FAKE_TOKEN = makeFakeJwt({ sub: 'v-1', psr: 'role:vendor-operator', scope: { vndr: OPERATOR_VNDR } })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

const RETURN_CSV = [
  'Dispatch ID,Device ID,AWB,Courier Partner,Dispatch Date',
  'asgn_1,dev-serial-1,AWB123,DTDC,2026-08-01',
  'asgn_2,dev-serial-2,AWB124,,2026-08-02',
].join('\n')

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function makeOversizedFile(): File {
  return new File([new Uint8Array(6 * 1024 * 1024)], 'huge.csv', { type: 'text/csv' })
}

// jsdom's Blob implementation does not implement Blob.text()/arrayBuffer(),
// only FileReader (same limitation the app code itself works around in
// parseReturn.ts's readFileAsText), so this reads the multipart file part
// the same way.
function readFormFileText(form: FormData): Promise<string> {
  const filePart = form.get('file')
  if (!(filePart instanceof Blob)) throw new Error('expected a file part')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('failed to read the file part'))
    reader.readAsText(filePart)
  })
}

describe('return upload', () => {
  beforeEach(() => {
    clearAccessToken()
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('parses a valid CSV to the exact ReturnSheet JSON and POSTs multipart/form-data to /vendor/return with a Bearer header and the operator token vndr', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
        if (url.includes('/vendor/return')) return jsonResponse({ pairedUnitIds: ['unit_1', 'unit_2'], quarantined: 0, shptIds: ['shpt_1'], deduped: false })
        return jsonResponse({})
      }),
    )

    renderHarness()

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    await userEvent.upload(input, makeFile(RETURN_CSV, 'return.csv'))

    expect(await screen.findByText(/2 row\(s\) parsed/i)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /submit return sheet/i }))

    expect(await screen.findByText('2')).toBeTruthy() // Paired count

    const call = calls.find((c) => c.url.includes('/vendor/return'))
    expect(call).toBeTruthy()
    expect(headerValue(call!, 'Authorization')).toBe(`Bearer ${FAKE_TOKEN}`)
    expect(call!.init.method).toBe('POST')
    expect(call!.init.body).toBeInstanceOf(FormData)

    const sheetText = await readFormFileText(call!.init.body as FormData)
    const sheet = JSON.parse(sheetText) as Record<string, unknown>

    expect(Object.keys(sheet).sort()).toEqual(['fileId', 'rows', 'vndrId', 'workQueue'])
    expect(sheet.vndrId).toBe(OPERATOR_VNDR) // the operator's OWN token vndr, never caller-supplied
    expect(sheet.workQueue).toBe('vendor-portal')
    expect(typeof sheet.fileId).toBe('string')

    const rows = sheet.rows as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(Object.keys(rows[0]!).sort()).toEqual(['asgnId', 'awb', 'courierCode', 'deviceSerial'])
    expect(rows[0]).toEqual({ deviceSerial: 'dev-serial-1', asgnId: 'asgn_1', awb: 'AWB123', courierCode: 'DTDC' })
    // Row 2 has no Courier Partner value: courierCode must be ABSENT, not an
    // empty string (assertOnlyKeys permits it missing, not blank).
    expect(Object.keys(rows[1]!).sort()).toEqual(['asgnId', 'awb', 'deviceSerial'])
    expect(rows[1]).toEqual({ deviceSerial: 'dev-serial-2', asgnId: 'asgn_2', awb: 'AWB124' })
    // "Dispatch Date" is not a ReturnRow field anywhere in the payload.
    expect(JSON.stringify(sheet)).not.toContain('2026-08-01')
  })

  it('a retry after a submit failure re-POSTs the SAME fileId (stable per parsed file, not fresh per click)', async () => {
    const calls: Call[] = []
    let returnCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
        if (url.includes('/vendor/return')) {
          returnCallCount += 1
          if (returnCallCount === 1) return new Response('', { status: 500 })
          return jsonResponse({ pairedUnitIds: ['unit_1'], quarantined: 0, shptIds: [], deduped: false })
        }
        return jsonResponse({})
      }),
    )

    renderHarness()

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    await userEvent.upload(input, makeFile(RETURN_CSV, 'return.csv'))
    await screen.findByText(/2 row\(s\) parsed/i)

    await userEvent.click(screen.getByRole('button', { name: /submit return sheet/i }))
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: /submit return sheet/i }))
    await screen.findByText('1')

    const returnCalls = calls.filter((c) => c.url.includes('/vendor/return'))
    expect(returnCalls).toHaveLength(2)
    const fileId1 = JSON.parse(await readFormFileText(returnCalls[0]!.init.body as FormData)).fileId as string
    const fileId2 = JSON.parse(await readFormFileText(returnCalls[1]!.init.body as FormData)).fileId as string
    expect(fileId1).toBe(fileId2)
  })

  it('a CSV missing a required column (AWB) is rejected client-side with a message and never POSTs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    renderHarness()

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    const badCsv = ['Dispatch ID,Device ID,Courier Partner', 'asgn_1,dev-serial-1,DTDC'].join('\n')
    await userEvent.upload(input, makeFile(badCsv, 'bad.csv'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/AWB/i)
    expect(fetchMock.mock.calls.some(([url]: [string]) => url.includes('/vendor/return'))).toBe(false)
    expect(screen.queryByRole('button', { name: /submit return sheet/i })).toBeNull()
  })

  it('a file over 5 MB is rejected client-side and never POSTs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    renderHarness()

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MB/i)
    expect(fetchMock.mock.calls.some(([url]: [string]) => url.includes('/vendor/return'))).toBe(false)
    expect(screen.queryByRole('button', { name: /submit return sheet/i })).toBeNull()
  })

  // ONE DISPATCH ID, TWO AWBs (2026-08-10). The soundbox kit ships under one
  // AWB and the standee under another, so a row with a BLANK Device ID is a
  // collateral report rather than a broken row. It used to throw and take the
  // whole file with it.
  it('accepts a BLANK Device ID as a collateral row, omitting the key so the edge reads it as collateral', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
        if (url.includes('/vendor/return')) {
          return jsonResponse({ pairedUnitIds: ['unit_1'], quarantined: 0, shptIds: ['shpt_1'], collateralLinked: 1, deduped: false })
        }
        return jsonResponse({})
      }),
    )

    renderHarness()

    const collateralCsv = [
      'Dispatch ID,Device ID,AWB,Courier Partner,Dispatch Date',
      'asgn_1,dev-serial-1,AWB123,DTDC,2026-08-01',
      'asgn_1,,AWB-STANDEE,DTDC,2026-08-01',
    ].join('\n')

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    await userEvent.upload(input, makeFile(collateralCsv, 'return.csv'))
    expect(await screen.findByText(/2 row\(s\) parsed/i)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /submit return sheet/i }))
    expect(await screen.findByText(/collateral/i)).toBeTruthy()

    const call = calls.find((c) => c.url.includes('/vendor/return'))!
    const rows = (JSON.parse(await readFormFileText(call.init.body as FormData)) as { rows: Record<string, unknown>[] }).rows
    expect(rows).toHaveLength(2)
    // The KEY must be ABSENT on the collateral row, not ''. The edge's
    // requireString rejects an empty string, and only an absent key means
    // collateral, so sending '' would 400 the whole file.
    expect(Object.keys(rows[1]!).sort()).toEqual(['asgnId', 'awb', 'courierCode'])
    expect(rows[1]).toEqual({ asgnId: 'asgn_1', awb: 'AWB-STANDEE', courierCode: 'DTDC' })
  })

  it('still rejects a row missing Dispatch ID or AWB, naming only those two', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    renderHarness()

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    const badCsv = ['Dispatch ID,Device ID,AWB', 'asgn_1,dev-serial-1,'].join('\n')
    await userEvent.upload(input, makeFile(badCsv, 'bad.csv'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Dispatch ID or AWB/i)
    // Device ID must NOT be named as a required value any more.
    expect(alert.textContent).not.toMatch(/Device ID/i)
    expect(fetchMock.mock.calls.some(([url]: [string]) => url.includes('/vendor/return'))).toBe(false)
  })

  it('surfaces the collateral count in the result banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/session/login')) return jsonResponse({ accessToken: FAKE_TOKEN })
        if (url.includes('/vendor/return')) {
          return jsonResponse({ pairedUnitIds: ['unit_1', 'unit_2'], quarantined: 0, shptIds: ['shpt_1'], collateralLinked: 3, deduped: false })
        }
        return jsonResponse({})
      }),
    )

    renderHarness()

    const input = (await screen.findByLabelText(/return sheet file/i)) as HTMLInputElement
    await userEvent.upload(input, makeFile(RETURN_CSV, 'return.csv'))
    await screen.findByText(/2 row\(s\) parsed/i)
    await userEvent.click(screen.getByRole('button', { name: /submit return sheet/i }))

    const collateralTerm = await screen.findByText(/^Collateral$/i)
    expect(collateralTerm.nextElementSibling?.textContent).toBe('3')
  })
})
