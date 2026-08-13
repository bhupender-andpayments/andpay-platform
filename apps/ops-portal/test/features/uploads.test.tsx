import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
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

// The bank fixtures that used to live here (BANK_ROW_1/2, BANK_PREVIEW_RESULT)
// moved to test/features/workflow-upload.test.tsx along with the bank flow
// itself (2026-08-11 ruling).

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

// The preview the page now fetches the moment a file is picked. It writes
// nothing; it exists so the operator can see the sheet before committing.
const DEVICE_INVENTORY_PREVIEW = {
  rows: [
    { rowNo: 1, deviceId: '869123450000001', simNo: '89910000123450001', deviceQr: 'DQR-1', errors: [], alreadyInStock: false, simAlreadyUsed: false, duplicateInFile: false },
    { rowNo: 2, deviceId: '869123450000002', simNo: '89910000123450002', deviceQr: 'DQR-2', errors: [], alreadyInStock: true, simAlreadyUsed: false, duplicateInFile: false },
    { rowNo: 4, deviceId: '', simNo: '', deviceQr: '', errors: ['missing_sim_no'], alreadyInStock: false, simAlreadyUsed: false, duplicateInFile: false },
  ],
  totalRows: 3,
  willAdd: 1,
  willFlag: 1,
  willReject: 1,
}

const DEVICE_INVENTORY_RESULT = {
  fileId: 'file-3',
  accepted: 2,
  flagged: 1,
  invalid: 1,
  createdUnitIds: ['unit-1', 'unit-2'],
  invalidRows: [{ rowNo: 4, errors: ['missing_sim_no'] }],
  flaggedRows: [{ rowNo: 2, errors: ['duplicate_device_serial_existing_unit'] }],
  deduped: false,
}

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function makeOversizedFile(name = 'huge.csv'): File {
  // 6 MB of zero bytes, well past the 5 MB cap. No need for real content
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

// (The renderAt helper that mounted /uploads/* here was removed with the
// 2026-08-12 device-inventory move.)

// The manufacturer field is a SearchSelect now, not a native select, so it is
// driven by opening it and clicking an option rather than by selectOptions.
async function pickManufacturer(name: RegExp = /acme devices/i): Promise<void> {
  await userEvent.click(await screen.findByLabelText(/manufacturer/i))
  await userEvent.click(await screen.findByRole('option', { name }))
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

  // The three-TAB layout, and its default-to-bank behaviour, were removed in
  // redesign step 4: they are the thing that step deletes. Uploads is now an
  // index of two equal cards (bank moved out to the workflow workspace on
  // 2026-08-11), each on its own route, covered by
  // test/features/uploads-index.test.tsx. The per-upload behaviour (preview,
  // commit, per-row errors) is unchanged and still covered below. The bank
  // coverage that used to live here now lives in
  // test/features/workflow-upload.test.tsx against UploadStage/ValidateStage
  // directly.

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

    // Commit is now its own step (ruling 2026-08-11): Review must be left
    // deliberately before the commit button exists at all.
    await userEvent.click(screen.getByRole('button', { name: /continue to commit/i }))

    await userEvent.click(screen.getByRole('button', { name: /commit damage report file/i }))
    expect(await screen.findByText('Replaced')).toBeTruthy()

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/damage/commit'))).toBe(true)
    })
    const commitCall = calls.find((c) => c.url.includes('/ops/uploads/damage/commit'))!
    expect(headerValue(commitCall, 'Idempotency-Key')).toBeTruthy()
    expect(screen.getByRole('link', { name: /view in quarantine queue/i })).toBeTruthy()
  })

  it('damage upload: a file over 5 MB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(DAMAGE_PREVIEW_RESULT))
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<DamageUploadPage />)

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Ruling 2026-08-11: Commit moved off the Review card onto its own rail
  // step, so a preview no longer hands the operator a commit button in the
  // same breath as the table.
  it('damage: preview lands on Review, and Commit is its own step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/uploads/damage/preview')) return jsonResponse(DAMAGE_PREVIEW_RESULT)
        if (url.includes('/ops/uploads/damage/commit')) return jsonResponse({ replaced: 1, quarantined: 1, duplicate: 0, fileId: 'file-2' })
        return jsonResponse({})
      }),
    )

    renderWithProviders(<DamageUploadPage />)

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'damage.csv'))

    // After preview resolves: the summary and per-row table render, and the
    // commit button does NOT exist yet.
    expect(await screen.findByText(/row\(s\) previewed/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /commit damage report file/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /continue to commit/i }))

    // The commit step states what is about to be written, then offers the button.
    expect(screen.getByText(/will open replacements/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /commit damage report file/i })).toBeTruthy()
  })

  // Review fix, round 1: a committed file's preview is stale, so Review must
  // LOCK rather than stay clickable with the click going nowhere. Upload
  // stays a real, clickable way to start over.
  it('damage: once committed, the Review rail pill locks (renders inert, not a button); Upload stays clickable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/uploads/damage/preview')) return jsonResponse(DAMAGE_PREVIEW_RESULT)
        if (url.includes('/ops/uploads/damage/commit')) return jsonResponse({ replaced: 1, quarantined: 1, duplicate: 0, fileId: 'file-2' })
        return jsonResponse({})
      }),
    )

    renderWithProviders(<DamageUploadPage />)

    const input = screen.getByLabelText(/damage report file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'damage.csv'))
    expect(await screen.findByText(/row\(s\) previewed/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /continue to commit/i }))
    await userEvent.click(screen.getByRole('button', { name: /commit damage report file/i }))
    expect(await screen.findByText('Replaced')).toBeTruthy()

    const railPill = (label: string) => new RegExp(`^\\d\\s*${label}$`, 'i')
    // Locked: Review's own label text still renders in the rail, but it is
    // no longer a button (UploadStepper renders a locked step as an inert
    // span).
    expect(screen.getByText(/^review$/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: railPill('review') })).toBeNull()
    // Still a real move: Upload remains clickable so a new file can be picked.
    expect(screen.getByRole('button', { name: railPill('upload') })).toBeTruthy()
  })

  // 2026-08-13 review: the rail is GONE. It had three pills whose third,
  // "Submit", only restated the screen the operator was already on, behind one
  // extra click. The breadcrumb says where they are; the page is now one screen.
  it('device inventory: no step rail at all, and a way back to Inventory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    expect(await screen.findByText(/device inventory upload/i)).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: /upload steps/i })).toBeNull()
    expect(screen.queryByText(/^submit$/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /continue to submit/i })).toBeNull()
    // A way out, which the page did not have: the breadcrumb is not a control.
    expect(screen.getByRole('link', { name: /back to inventory/i }).getAttribute('href')).toBe('/inventory')
  })

  // THE GAP THIS CLOSES: the operator picked a file and pressed a button with
  // no way to see what the sheet contained. Picking a file now previews it,
  // writing nothing, and each row says what will happen to it.
  it('device inventory: picking a file previews its rows and what will happen to each, writing nothing', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await screen.findByLabelText(/manufacturer/i)
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'inventory.csv'))

    // The real parsed rows render, with the SIM in full (admin console, no masking).
    expect(await screen.findByText('869123450000001')).toBeTruthy()
    expect(screen.getByText('89910000123450001')).toBeTruthy()
    expect(screen.getAllByText(/^will be added$/i).length).toBeGreaterThan(0)
    // Two matches on purpose since the vocabulary fix (2026-08-13): the summary
    // badge counts them ("1 already in inventory, will be skipped") and the row
    // itself says the same thing. Both are correct, so the count is asserted
    // rather than uniqueness.
    expect(screen.getAllByText(/already in inventory, will be skipped/i).length).toBe(2)
    expect(screen.getByText(/3 rows in this file/i)).toBeTruthy()

    // A preview carries NO Idempotency-Key and never touches the commit route.
    const previewCall = calls.find((c) => c.url.includes('/ops/uploads/device-inventory/preview'))!
    expect(headerValue(previewCall, 'Idempotency-Key')).toBeNull()
    expect(calls.some((c) => c.url.endsWith('/ops/uploads/device-inventory'))).toBe(false)
    expect(screen.getByText(/nothing has been saved yet/i)).toBeTruthy()
  })

  it('device inventory: Upload needs BOTH a file and a manufacturer, and posts them multipart', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        if (url.includes('/ops/uploads/device-inventory')) return jsonResponse(DEVICE_INVENTORY_RESULT)
        return jsonResponse({})
      }),
    )

    renderWithProviders(<DeviceInventoryUploadPage />)

    // Manufacturer options come from the REAL vendor read, filtered to
    // MANUFACTURER; the PRINT vendor must never be offered.
    await userEvent.click(await screen.findByLabelText(/manufacturer/i))
    expect(await screen.findByRole('option', { name: /acme devices/i })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /print co/i })).toBeNull()
    await userEvent.keyboard('{Escape}')

    const uploadButton = () => screen.getByRole('button', { name: /^upload$/i }) as HTMLButtonElement
    expect(uploadButton().disabled).toBe(true)

    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('irrelevant, the server parses this', 'inventory.csv'))
    // A file alone must not enable Upload, and nothing is committed by picking.
    expect(uploadButton().disabled).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/ops/uploads/device-inventory'))).toBe(false)

    await pickManufacturer()
    expect(uploadButton().disabled).toBe(false)

    await userEvent.click(uploadButton())

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/ops/uploads/device-inventory'))).toBe(true)
    })
    const uploadCall = calls.find((c) => c.url.endsWith('/ops/uploads/device-inventory'))!
    expect(headerValue(uploadCall, 'Authorization')).toBe('Bearer tok-1')
    expect(headerValue(uploadCall, 'Idempotency-Key')).toBeTruthy()
    expect(uploadCall.init.body).toBeInstanceOf(FormData)
    const form = uploadCall.init.body as FormData
    expect(form.get('manufacturerVndrId')).toBe('vndr_manu1')
    expect(await readFormFileText(form)).toBe('irrelevant, the server parses this')

    // The real per-row invalid breakdown from the mocked response.
    const acceptedDd = (await screen.findByText('Accepted')).nextElementSibling as HTMLElement
    expect(acceptedDd.textContent).toBe('2')
    expect(screen.getByText('Missing Sim No')).toBeTruthy()
  })

  // The 2026-08-12 ask that motivated flaggedRows: "already added" must be a
  // sentence naming the row, not a bare count. The two duplicate families
  // state DIFFERENT consequences (serial dup = skipped; SIM dup = device
  // created without a SIM), so each is pinned on its own copy.
  it('device inventory: a duplicate row is named, with what actually happened to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        if (url.includes('/ops/uploads/device-inventory')) {
          return jsonResponse({
            ...DEVICE_INVENTORY_RESULT,
            flaggedRows: [
              { rowNo: 2, errors: ['duplicate_device_serial_existing_unit'] },
              { rowNo: 5, errors: ['duplicate_sim_no_existing_unit'] },
            ],
          })
        }
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await pickManufacturer()
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'inventory.csv'))
    await userEvent.click(await screen.findByRole('button', { name: /^upload$/i }))

    expect(await screen.findByText(/this device is already added\. the row was skipped/i)).toBeTruthy()
    expect(screen.getByText(/already recorded on another device\. the device was added without a sim/i)).toBeTruthy()
  })

  // An idempotency replay returns all-zero counts, which used to read as a
  // failed upload. It is a SAFE no-op and the page must say so.
  it('device inventory: a replayed file says "already processed" instead of reading as failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        if (url.includes('/ops/uploads/device-inventory')) {
          return jsonResponse({ ...DEVICE_INVENTORY_RESULT, accepted: 0, flagged: 0, invalid: 0, createdUnitIds: [], invalidRows: [], flaggedRows: [], deduped: true })
        }
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await pickManufacturer()
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'inventory.csv'))
    await userEvent.click(await screen.findByRole('button', { name: /^upload$/i }))

    expect(await screen.findByText(/this exact file was already processed/i)).toBeTruthy()
  })

  it('device inventory upload: a file over 5 MB is rejected client-side and never posted', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
      if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
      return jsonResponse(DEVICE_INVENTORY_RESULT)
    })
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<DeviceInventoryUploadPage />)

    await screen.findByLabelText(/manufacturer/i)
    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeOversizedFile('huge.csv'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MB/i)
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
          if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        if (url.includes('/ops/uploads/device-inventory')) return jsonResponse(body, status)
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await screen.findByLabelText(/manufacturer/i)
    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('Device ID,Device QR\nD1,{}\n', 'cwd-export.csv'))
    await pickManufacturer()
    await userEvent.click(await screen.findByRole('button', { name: /^upload$/i }))
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
        if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        return jsonResponse(DEVICE_INVENTORY_RESULT)
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await screen.findByLabelText(/device inventory file/i)

    const uploadButton = () => screen.getByRole('button', { name: /^upload$/i }) as HTMLButtonElement
    const zone = screen.getByText(/Drop your file here/i).closest('div')!
    const dropped = makeFile('Device ID,Sim No,Device QR\n1,2,3\n', 'dropped-inventory.csv')

    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } })

    // Staged: the file is named, sized, and the zone's idle prompt is gone.
    expect(await screen.findByText('dropped-inventory.csv')).toBeTruthy()
    expect(screen.getByText(/ready to upload/i)).toBeTruthy()
    expect(screen.queryByText(/Drop your file here/i)).toBeNull()

    // A manufacturer is still required, so a drop alone must not enable Upload.
    expect(uploadButton().disabled).toBe(true)
    await pickManufacturer()
    expect(uploadButton().disabled).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /remove file/i }))
    expect(await screen.findByText(/Drop your file here/i)).toBeTruthy()
    expect(uploadButton().disabled).toBe(true)
  })

  it('device inventory upload: an oversized DROP is refused with the same limit message as a pick', async () => {
    // The size cap lives on the page, so it must apply to the drop path too and
    // not just to the file dialog.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) return jsonResponse(DEVICE_INVENTORY_PREVIEW)
        return jsonResponse(DEVICE_INVENTORY_RESULT)
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await screen.findByLabelText(/device inventory file/i)
    const zone = screen.getByText(/Drop your file here/i).closest('div')!

    fireEvent.drop(zone, { dataTransfer: { files: [makeOversizedFile('huge-drop.csv')] } })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/5 MB/i)
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

  // Finding 5: onStepClick('upload') cleared `result` but not
  // `structuralErrors`, so after a structural rejection, clicking Upload then
  // Continue without picking a new file re-rendered the PREVIOUS rejection
  // above a fresh confirm line, a screen asserting a rejection that has not
  // happened this time.
  // The rail this used to navigate is gone (2026-08-13), but the invariant it
  // guarded is not: a rejection belongs to the FILE that caused it. Left
  // standing over a newly picked file, the screen would assert a rejection that
  // has not happened this time.
  it('device inventory upload: picking a new file clears the previous rejection', async () => {
    await submitInventory(400, {
      code: 'invalid',
      message: 'invalid request',
      reasons: [{ code: 'missing_required_column', column: 'Sim No' }],
    })
    expect(await screen.findByText(/Missing required column "Sim No"/)).toBeTruthy()

    await userEvent.upload(
      screen.getByLabelText(/device inventory file/i),
      makeFile('Device ID,Sim No,Device QR\n1,2,3\n', 'fixed.csv'),
    )

    await waitFor(() => {
      expect(screen.queryByText(/Missing required column "Sim No"/)).toBeNull()
    })
  })

  // 2026-08-13 fix: a file whose every row was already in inventory previewed
  // "0 will be added" but Upload stayed enabled, so an operator uploaded it
  // three times and wrote 36 unactionable rows into Queues. Upload must
  // refuse a file with nothing to add AND nothing to quarantine.
  it('device inventory upload: a file with nothing to add and nothing to fix disables Upload, with a stated reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) {
          return jsonResponse({
            rows: [{ rowNo: 1, deviceId: '869123450000001', simNo: '89910000123450001', deviceQr: 'DQR-1', errors: [], alreadyInStock: true, simAlreadyUsed: false, duplicateInFile: false }],
            totalRows: 1,
            willAdd: 0,
            willFlag: 1,
            willReject: 0,
          })
        }
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await pickManufacturer()
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'all-known.csv'))

    expect(await screen.findByText(/every device in this file is already in inventory/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^upload$/i })).toHaveProperty('disabled', true)
  })

  // The opposite file must stay submittable: nothing will be ADDED, but
  // something will be QUARANTINED for correction, and quarantining it is the
  // whole point of uploading. `willAdd === 0` alone must never be the block
  // condition.
  it('device inventory upload: an all-malformed file (nothing to add, rows to fix) leaves Upload enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) {
          return jsonResponse({
            rows: [
              { rowNo: 1, deviceId: '', simNo: '', deviceQr: '', errors: ['missing_device_id'], alreadyInStock: false, simAlreadyUsed: false, duplicateInFile: false },
              { rowNo: 2, deviceId: '', simNo: '', deviceQr: '', errors: ['missing_device_id'], alreadyInStock: false, simAlreadyUsed: false, duplicateInFile: false },
            ],
            totalRows: 2,
            willAdd: 0,
            willFlag: 0,
            willReject: 2,
          })
        }
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await pickManufacturer()
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'all-malformed.csv'))

    await screen.findByText(/2 need fixing/i)
    expect(screen.getByRole('button', { name: /^upload$/i })).toHaveProperty('disabled', false)
    expect(screen.queryByText(/every device in this file is already in inventory/i)).toBeNull()
  })

  it('device inventory upload: a preview that fails structurally also disables Upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) {
          return jsonResponse({ code: 'invalid', message: 'invalid request', reasons: [{ code: 'missing_required_column', column: 'Sim No' }] }, 400)
        }
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await pickManufacturer()
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'bad-header.csv'))

    expect(await screen.findByText(/Missing required column "Sim No"/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^upload$/i })).toHaveProperty('disabled', true)
  })

  // The worked example the 2026-08-13 ruling was written against: a 12-row
  // file with 5 new devices, 5 already in inventory, and 2 with a format
  // problem. The file uploads (it has both something to add and something to
  // fix), and only the format problems point at Queues.
  it('device inventory upload: a mixed 5-new/5-duplicate/2-needs-fixing file uploads, and only the rows that need fixing point at Queues', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        if (url.includes('/ops/uploads/device-inventory/preview')) {
          return jsonResponse({ rows: [], totalRows: 12, willAdd: 5, willFlag: 5, willReject: 2 })
        }
        if (url.includes('/ops/uploads/device-inventory')) {
          return jsonResponse({
            fileId: 'file-mixed',
            accepted: 5,
            flagged: 5,
            invalid: 2,
            createdUnitIds: ['unit-1', 'unit-2', 'unit-3', 'unit-4', 'unit-5'],
            invalidRows: [
              { rowNo: 11, errors: ['missing_device_id'] },
              { rowNo: 12, errors: ['malformed_device_id'] },
            ],
            flaggedRows: [
              { rowNo: 6, errors: ['duplicate_device_serial_existing_unit'] },
              { rowNo: 7, errors: ['duplicate_device_serial_existing_unit'] },
              { rowNo: 8, errors: ['duplicate_device_serial_existing_unit'] },
              { rowNo: 9, errors: ['duplicate_device_serial_existing_unit'] },
              { rowNo: 10, errors: ['duplicate_device_serial_existing_unit'] },
            ],
            queuedForReview: 2,
            deduped: false,
          })
        }
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    await pickManufacturer()
    await userEvent.upload(screen.getByLabelText(/device inventory file/i), makeFile('x', 'mixed.csv'))

    const uploadButton = () => screen.getByRole('button', { name: /^upload$/i }) as HTMLButtonElement
    await screen.findByText(/5 need fixing|already in inventory/i)
    expect(uploadButton().disabled).toBe(false)

    await userEvent.click(uploadButton())

    // The 5 devices got added.
    expect(await screen.findByText('Accepted')).toBeTruthy()
    const acceptedDd = (await screen.findByText('Accepted')).nextElementSibling as HTMLElement
    expect(acceptedDd.textContent).toBe('5')

    // The 5 duplicates are named as skipped, with NO Queues link anywhere
    // near them: only ONE Queues link exists on the page, and it belongs to
    // the 2 rows that need fixing.
    expect(screen.getByText(/these rows were skipped\. no action is needed/i)).toBeTruthy()
    const queuesLinks = screen.getAllByRole('link', { name: /queues, under intake exceptions/i })
    expect(queuesLinks).toHaveLength(1)
  })
})
