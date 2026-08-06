import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { UploadsPage } from '../../src/features/uploads/UploadsPage.js'
import { BankUploadPage } from '../../src/features/uploads/BankUploadPage.js'
import { DamageUploadPage } from '../../src/features/uploads/DamageUploadPage.js'
import { DeviceInventoryUploadPage } from '../../src/features/uploads/DeviceInventoryUploadPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed ops-edge contract (apps/ops-edge/src/ops.controller.ts's
// previewBank/commitBank/previewDamage/commitDamage/uploadDeviceInventory,
// grounded against services/tms/src/ops.ts and
// services/fulfillment/src/ops-device-inventory.ts):
//   POST /ops/uploads/bank/preview             multipart `file`, no
//     Idempotency-Key, writes nothing -> BankPreviewResult
//   POST /ops/uploads/bank/commit               multipart `file`,
//     Idempotency-Key -> { accepted, quarantined, duplicate, fileId }
//   POST /ops/uploads/damage/preview            multipart `file`, no
//     Idempotency-Key, writes nothing -> DamagePreviewResult (Phase 7 Task 7,
//     L11/FR08-3 decision item 11: preview parity for the damage upload)
//   POST /ops/uploads/damage/commit             multipart `file`,
//     Idempotency-Key -> { replaced, quarantined, duplicate, fileId }
//   POST /ops/uploads/device-inventory           multipart `file` +
//     `manufacturerVndrId` field, Idempotency-Key -> OpsDeviceInventoryResult
//     (Phase-5 Task 1 edge, wired here for the first time)
// These are raw multipart `fetch`es (mirrors apps/vendor-portal
// ReturnUploadPage.tsx's approach), NOT plain JSON: the server parses and
// validates the raw file, so no rows are ever posted by the SPA. GET
// /ops/vendors (the JSON client, via useAuth().client) sources the
// manufacturer select.

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

const DAMAGE_ROW_1 = {
  fileId: 'file-2',
  rowNo: 1,
  tenantReference: 'HDFC',
  vpaValue: 'acme@hdfcbank',
  damageReason: 'battery issue',
  bankRemarks: 'replace asap',
  shipToAddress: 'New Addr',
}

const DAMAGE_ROW_2 = {
  fileId: 'file-2',
  rowNo: 2,
  tenantReference: 'HDFC',
  vpaValue: 'unknown@hdfcbank',
  damageReason: 'x',
  bankRemarks: '',
  shipToAddress: 'A',
}

const DAMAGE_PREVIEW_RESULT = {
  rows: [
    { rowNo: 1, valid: true, row: DAMAGE_ROW_1 },
    { rowNo: 2, valid: false, reasonCode: 'no_match', row: DAMAGE_ROW_2 },
  ],
  summary: { total: 2, valid: 1, invalid: 1 },
  structuralErrors: [],
}

const MANUFACTURERS = [
  {
    id: 'vndr_manu1',
    type: 'MANUFACTURER',
    displayName: 'Acme Devices',
    status: 'ACTIVE',
    courierCode: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'vndr_print1',
    type: 'PRINT',
    displayName: 'Print Co',
    status: 'ACTIVE',
    courierCode: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
]

const DEVICE_INVENTORY_RESULT = {
  fileId: 'file-3',
  accepted: 2,
  flagged: 1,
  invalid: 1,
  createdUnitIds: ['unit-1', 'unit-2'],
  invalidRows: [{ rowNo: 4, errors: ['missing_sim_no'] }],
  deduped: false,
}

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function makeOversizedFile(name = 'huge.csv'): File {
  // 6 MiB of zero bytes, well past the 5 MiB cap. No need for real content
  // since the size check must reject before any preview/commit network call.
  return new File([new Uint8Array(6 * 1024 * 1024)], name, { type: 'text/csv' })
}

function renderWithProviders(ui: ReactElement) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  )
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

  it('UploadsPage renders all three upload tabs (bank, damage, device inventory)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    renderWithProviders(<UploadsPage />)
    expect(screen.getByRole('button', { name: 'Bank Requests' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Damage Reports' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Device Inventory' })).toBeTruthy()
    // Defaults to the bank tab.
    expect(screen.getByLabelText(/bank request file/i)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Device Inventory' }))
    expect(await screen.findByLabelText(/manufacturer/i)).toBeTruthy()
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

    renderWithProviders(<BankUploadPage />)

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'bank.csv'))

    // The preview per-row results render in a table before any commit. Real
    // per-row data (BMR-1/BMR-2), not decorative rows.
    expect(await screen.findByText('BMR-1')).toBeTruthy()
    expect(screen.getByText('BMR-2')).toBeTruthy()
    expect(screen.getByText('Missing Recipient Contact')).toBeTruthy()
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

    renderWithProviders(<BankUploadPage />)

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

    renderWithProviders(<BankUploadPage />)

    const input = screen.getByLabelText(/bank request file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('bad file', 'bank.csv'))

    expect(await screen.findByText(/missing required column: mobile/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /commit bank request file/i })).toBeNull()
  })

  it('damage upload: picking a file POSTs it multipart to preview (no Idempotency-Key, writes nothing) and renders the real per-row projected outcome, then Commit POSTs with a fresh Idempotency-Key and shows the counts', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/uploads/damage/preview')) return jsonResponse(DAMAGE_PREVIEW_RESULT)
        if (url.includes('/ops/uploads/damage/commit')) {
          return jsonResponse({ replaced: 1, quarantined: 1, duplicate: 0, fileId: 'file-2' })
        }
        return jsonResponse({})
      }),
    )

    renderWithProviders(<DamageUploadPage />)

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'damage.csv'))

    // Real per-row preview data renders before any commit call is made.
    expect(await screen.findByText('acme@hdfcbank')).toBeTruthy()
    expect(screen.getByText('unknown@hdfcbank')).toBeTruthy()
    expect(screen.getByText('No Match')).toBeTruthy()
    expect(screen.getByText(/2 row\(s\) previewed/i)).toBeTruthy()

    const previewCall = calls.find((c) => c.url.includes('/ops/uploads/damage/preview'))
    expect(previewCall).toBeTruthy()
    expect(headerValue(previewCall!, 'Idempotency-Key')).toBeNull()
    expect(calls.some((c) => c.url.includes('/ops/uploads/damage/commit'))).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /commit damage report file/i }))
    expect(await screen.findByText('Replaced')).toBeTruthy()

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/damage/commit'))).toBe(true)
    })
    const commitCall = calls.find((c) => c.url.includes('/ops/uploads/damage/commit'))!
    expect(headerValue(commitCall, 'Idempotency-Key')).toBeTruthy()
    expect(screen.getByRole('link', { name: /view in quarantine queue/i })).toBeTruthy()
  })

  it('damage upload: a file over 5 MiB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(DAMAGE_PREVIEW_RESULT))
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<DamageUploadPage />)

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('device inventory upload: requires a manufacturer AND a file before Submit is enabled; submits multipart with the manufacturer wire id + a fresh Idempotency-Key; renders real per-row invalid errors without a preview stage', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory')) return jsonResponse(DEVICE_INVENTORY_RESULT)
        return jsonResponse({})
      }),
    )

    renderWithProviders(<DeviceInventoryUploadPage />)

    // Manufacturer options are sourced from the REAL vendor read, filtered to
    // type === MANUFACTURER; the PRINT vendor must never appear as an option.
    const select = (await screen.findByLabelText(/manufacturer/i)) as HTMLSelectElement
    expect(within(select).getByText('Acme Devices')).toBeTruthy()
    expect(within(select).queryByText('Print Co')).toBeNull()

    const submitButton = screen.getByRole('button', { name: /upload device inventory file/i }) as HTMLButtonElement
    expect(submitButton.disabled).toBe(true)

    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'inventory.csv'))
    // A file alone (no manufacturer yet) must not enable Submit, and nothing
    // is posted to the upload route merely from picking a file.
    expect(submitButton.disabled).toBe(true)
    expect(calls.some((c) => c.url.includes('/ops/uploads/device-inventory'))).toBe(false)

    await userEvent.selectOptions(select, 'vndr_manu1')
    expect(submitButton.disabled).toBe(false)

    await userEvent.click(submitButton)

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/device-inventory'))).toBe(true)
    })
    const uploadCall = calls.find((c) => c.url.includes('/ops/uploads/device-inventory'))!
    expect(headerValue(uploadCall, 'Authorization')).toBe('Bearer tok-1')
    expect(headerValue(uploadCall, 'Idempotency-Key')).toBeTruthy()
    expect(uploadCall.init.body).toBeInstanceOf(FormData)
    const form = uploadCall.init.body as FormData
    expect(form.get('manufacturerVndrId')).toBe('vndr_manu1')
    const fileText = await readFormFileText(form)
    expect(fileText).toBe('irrelevant, the server parses this')

    // Real per-row invalid breakdown from the mocked response: no decorative
    // rows, exactly what the server reported (row 4, missing_sim_no).
    expect(await screen.findByText('2')).toBeTruthy() // Accepted
    expect(screen.getByText('Missing Sim No')).toBeTruthy()
    const rowCell = screen.getByText('4')
    expect(rowCell).toBeTruthy()
  })

  it('device inventory upload: a file over 5 MiB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
      return jsonResponse(DEVICE_INVENTORY_RESULT)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<DeviceInventoryUploadPage />)

    await screen.findByLabelText(/manufacturer/i)
    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile('huge.csv'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/ops/uploads/device-inventory'), expect.anything())
  })

  // Step 1 Task 3: a STRUCTURAL rejection (a wrong header) used to surface as
  // the bare ApiError message, i.e. the literal string "api 400", so an
  // operator could not tell which column was wrong. Per-ROW errors already
  // rendered well; only whole-file failures were opaque. The 400 is stubbed
  // here rather than the endpoint function, so the real decode path
  // (postFile -> ApiError -> deviceInventoryStructuralReasons) is exercised.
  async function submitInventory(status: number, body: unknown): Promise<void> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory')) return jsonResponse(body, status)
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    const select = (await screen.findByLabelText(/manufacturer/i)) as HTMLSelectElement
    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('Device ID,Device QR\nD1,{}\n', 'cwd-export.csv'))
    await userEvent.selectOptions(select, 'vndr_manu1')
    await userEvent.click(screen.getByRole('button', { name: /upload device inventory file/i }))
  }

  it('device inventory upload: names the offending column when the header is wrong', async () => {
    await submitInventory(400, {
      code: 'invalid',
      message: 'invalid request',
      reasons: [{ code: 'missing_required_column', column: 'Sim No' }],
    })
    expect(await screen.findByText(/Missing required column "Sim No"/)).toBeTruthy()
    // The operator is also told what a valid file looks like, and that the
    // whole file was rejected rather than partially ingested.
    expect(screen.getByText(/Expected columns: Device ID, Sim No, Device QR/)).toBeTruthy()
    expect(screen.getByText(/No rows were ingested/)).toBeTruthy()
    // The useless raw message must be gone.
    expect(screen.queryByText(/api 400/)).toBeNull()
  })

  it('device inventory upload: a bad extension reads as a file-type problem and never echoes the filename', async () => {
    await submitInventory(400, {
      code: 'invalid',
      message: 'invalid request',
      reasons: [{ code: 'unsupported_extension' }],
    })
    const note = await screen.findByText(/Upload a \.csv or \.xlsx file/)
    // S4/5c: the edge sends a CODE only, so no server-derived text can carry the
    // uploaded filename. The error copy is therefore built entirely client-side
    // and never interpolates it. (That the RESPONSE omits it is asserted where
    // it belongs, on the wire, in apps/ops-edge/test/device-inventory-http.test.ts.)
    // The filename does still appear in the staged-file card, because that is
    // the operator's own pick echoed back to them, not a disclosure.
    expect(note.textContent).not.toMatch(/cwd-export\.csv/)
  })

  // The drop zone is the shared file control on all three upload tabs. A real
  // DROP must stage the file exactly as picking it does, otherwise the affordance
  // the zone advertises is decorative.
  it('device inventory upload: dropping a file stages it, shows its size, and Remove clears it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        return jsonResponse(DEVICE_INVENTORY_RESULT)
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await screen.findByLabelText(/device inventory file/i)

    const submit = screen.getByRole('button', { name: /upload device inventory file/i }) as HTMLButtonElement
    const zone = screen.getByText(/Drop your file here/i).closest('div')!
    const dropped = makeFile('Device ID,Sim No,Device QR\n1,2,3\n', 'dropped-inventory.csv')

    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } })

    // Staged: the file is named, sized, and the zone's idle prompt is gone.
    expect(await screen.findByText('dropped-inventory.csv')).toBeTruthy()
    expect(screen.getByText(/ready to upload/i)).toBeTruthy()
    expect(screen.queryByText(/Drop your file here/i)).toBeNull()

    // A manufacturer is still required, so a drop alone must not enable Submit.
    expect(submit.disabled).toBe(true)
    await userEvent.selectOptions(screen.getByLabelText(/manufacturer/i), 'vndr_manu1')
    expect(submit.disabled).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /remove file/i }))
    expect(await screen.findByText(/Drop your file here/i)).toBeTruthy()
    expect(submit.disabled).toBe(true)
  })

  it('device inventory upload: an oversized DROP is refused with the same limit message as a pick', async () => {
    // The size cap lives on the page, so it must apply to the drop path too and
    // not just to the file dialog.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        return jsonResponse(DEVICE_INVENTORY_RESULT)
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await screen.findByLabelText(/device inventory file/i)
    const zone = screen.getByText(/Drop your file here/i).closest('div')!

    fireEvent.drop(zone, { dataTransfer: { files: [makeOversizedFile('huge-drop.csv')] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MiB/i)
    // Refused, so nothing is staged.
    expect(screen.queryByText('huge-drop.csv')).toBeNull()
  })

  it('device inventory upload: a 400 carrying no reasons falls back to the generic message and claims no column', async () => {
    await submitInventory(400, { code: 'invalid', message: 'invalid request' })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBeTruthy()
    // Nothing may be invented about which column was at fault.
    expect(screen.queryByText(/Missing required column/)).toBeNull()
    expect(screen.queryByText(/No rows were ingested/)).toBeNull()
  })
})
