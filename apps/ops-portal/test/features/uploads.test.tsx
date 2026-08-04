import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { BankUploadPage } from '../../src/features/uploads/BankUploadPage.js'
import { DamageUploadPage } from '../../src/features/uploads/DamageUploadPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract (Phase 2 Task 4 brief, grounded against
// apps/ops-edge/src/ops.controller.ts's previewBank/commitBank/commitDamage
// and services/tms/src/ops.ts):
//   POST /ops/uploads/bank/preview   multipart `file`, no Idempotency-Key,
//     writes nothing -> { rows: [{ rowNo, valid, errors, row }], summary, structuralErrors }
//   POST /ops/uploads/bank/commit    multipart `file`, Idempotency-Key
//     -> { accepted, quarantined, duplicate, fileId }
//   POST /ops/uploads/damage/commit  multipart `file`, Idempotency-Key
//     -> { replaced, quarantined, duplicate, fileId }
// This is a raw multipart `fetch` (mirrors apps/vendor-portal
// test/features/returns.test.tsx's approach), NOT plain JSON: the server now
// parses and validates the raw file, so no rows are ever posted by the SPA.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function headerValue(call: Call, name: string): string | null {
  const headers = call.init.headers as Record<string, string>
  return headers[name] ?? null
}

// jsdom's Blob implementation does not implement Blob.text()/arrayBuffer(),
// only FileReader, so the multipart file part is read back the same way the
// vendor-portal precedent's test does.
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

const BANK_ROW_1 = {
  fileId: 'file-1',
  rowNo: 1,
  bankMerchantReference: 'BMR-1',
  displayName: 'Acme Store',
  legalName: 'Acme Pvt Ltd',
  mcc: '5411',
  registeredAddress: '1 Market St',
  bankReferenceCode: 'BRC-1',
  productType: 'soundbox',
  vpaValue: 'acme@bank',
  qrValue: 'qr-data-1',
  soundbox: true,
  standeeCount: 1,
  stickerCount: 2,
  shipToAddress: '2 Ship Ln',
  contactName: 'Jane Doe',
  mobile: '9999999999',
}

const BANK_ROW_2 = {
  fileId: 'file-1',
  rowNo: 2,
  bankMerchantReference: 'BMR-2',
  displayName: 'Beta Store',
  legalName: 'Beta Pvt Ltd',
  mcc: '5412',
  registeredAddress: '2 Market St',
  bankReferenceCode: 'BRC-2',
  productType: 'soundbox',
  vpaValue: 'beta@bank',
  qrValue: 'qr-data-2',
  soundbox: false,
  standeeCount: 0,
  stickerCount: 1,
  shipToAddress: '3 Ship Ln',
  contactName: 'John Roe',
  mobile: '8888888888',
}

const BANK_PREVIEW_RESULT = {
  rows: [
    { rowNo: 1, valid: true, errors: [], row: BANK_ROW_1 },
    { rowNo: 2, valid: false, errors: ['missing_recipient_contact'], row: BANK_ROW_2 },
  ],
  summary: { total: 2, valid: 1, invalid: 1 },
  structuralErrors: [],
}

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function makeOversizedFile(): File {
  // 6 MiB of zero bytes, well past the 5 MiB cap. No need for real content
  // since the size check must reject before any preview/commit network call.
  return new File([new Uint8Array(6 * 1024 * 1024)], 'huge.csv', { type: 'text/csv' })
}

describe('uploads', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('bank upload: picking a file POSTs it multipart to preview with a Bearer header, renders the per-row results in a table, then Commit POSTs the same file multipart with a fresh Idempotency-Key and shows the counts', async () => {
    const calls: Call[] = []
    let commitCallCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/bank/preview')) return jsonResponse(BANK_PREVIEW_RESULT)
        if (url.includes('/ops/uploads/bank/commit')) {
          commitCallCount += 1
          return jsonResponse({ accepted: 1, quarantined: 1, duplicate: 0, fileId: 'file-1' })
        }
        return jsonResponse({})
      }),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <BankUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'bank.csv'))

    // The preview per-row results render in a table before any commit.
    expect(await screen.findByText('BMR-1')).toBeTruthy()
    expect(screen.getByText('BMR-2')).toBeTruthy()
    expect(screen.getByText('missing_recipient_contact')).toBeTruthy()
    expect(screen.getByText(/2 row\(s\) previewed/i)).toBeTruthy()

    const previewCall = calls.find((c) => c.url.includes('/ops/uploads/bank/preview'))
    expect(previewCall).toBeTruthy()
    expect(headerValue(previewCall!, 'Authorization')).toBe('Bearer tok-1')
    expect(headerValue(previewCall!, 'Idempotency-Key')).toBeNull() // preview writes nothing, no key
    expect(previewCall!.init.body).toBeInstanceOf(FormData)
    const previewText = await readFormFileText(previewCall!.init.body as FormData)
    expect(previewText).toBe('irrelevant, the server parses this')

    // Commit: a fresh Idempotency-Key, the SAME file, and the counts render.
    await userEvent.click(screen.getByRole('button', { name: /commit bank request file/i }))
    const acceptedDd = (await screen.findByText('Accepted')).nextElementSibling as HTMLElement
    expect(acceptedDd.textContent).toBe('1')

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/bank/commit'))).toBe(true)
    })
    expect(commitCallCount).toBe(1)
    const commitCall = calls.find((c) => c.url.includes('/ops/uploads/bank/commit'))!
    expect(headerValue(commitCall, 'Authorization')).toBe('Bearer tok-1')
    const idemKey = headerValue(commitCall, 'Idempotency-Key')
    expect(idemKey).toBeTruthy()
    expect(commitCall.init.body).toBeInstanceOf(FormData)
    const commitText = await readFormFileText(commitCall.init.body as FormData)
    expect(commitText).toBe('irrelevant, the server parses this')
  })

  it('bank upload: a file over 5 MiB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(BANK_PREVIEW_RESULT))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <BankUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bank upload: a structural parse failure surfaces the whole-file errors and renders no table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/uploads/bank/preview')) {
          return jsonResponse({
            rows: [],
            summary: { total: 0, valid: 0, invalid: 0 },
            structuralErrors: [{ code: 'missing_required_column', message: 'missing required column: mobile' }],
          })
        }
        return jsonResponse({})
      }),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <BankUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('bad file', 'bank.csv'))

    expect(await screen.findByText(/missing required column: mobile/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /commit bank request file/i })).toBeNull()
  })

  it('damage upload: picking a file POSTs it multipart to commit with a Bearer header and a fresh Idempotency-Key, and renders the counts', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/damage/commit')) {
          return jsonResponse({ replaced: 2, quarantined: 1, duplicate: 0, fileId: 'file-2' })
        }
        return jsonResponse({})
      }),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <DamageUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'damage.csv'))

    expect(await screen.findByText('2')).toBeTruthy() // Replaced count
    const quarantinedDd = screen.getByText('Quarantined').nextElementSibling as HTMLElement
    expect(quarantinedDd.textContent).toContain('1')
    expect(screen.getByRole('link', { name: /view in quarantine queue/i })).toBeTruthy()

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/damage/commit'))).toBe(true)
    })
    const call = calls.find((c) => c.url.includes('/ops/uploads/damage/commit'))!
    expect(headerValue(call, 'Authorization')).toBe('Bearer tok-1')
    expect(headerValue(call, 'Idempotency-Key')).toBeTruthy()
    expect(call.init.body).toBeInstanceOf(FormData)
    const bodyText = await readFormFileText(call.init.body as FormData)
    expect(bodyText).toBe('irrelevant, the server parses this')
  })

  it('damage upload: a file over 5 MiB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ replaced: 0, quarantined: 0, duplicate: 0, fileId: 'x' }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <DamageUploadPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
