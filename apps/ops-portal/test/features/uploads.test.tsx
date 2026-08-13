import type { ReactElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DamageUploadPage } from '../../src/features/uploads/DamageUploadPage.js'
import { DeviceInventoryUploadPage } from '../../src/features/uploads/DeviceInventoryUploadPage.js'
import { CourierStatusUploadPage } from '../../src/features/uploads/CourierStatusUploadPage.js'
import { ActivationUploadPage } from '../../src/features/uploads/ActivationUploadPage.js'
import { UploadsPage } from '../../src/features/uploads/UploadsPage.js'
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

// D-17 (T5.1). The two vendor types are seeded together so the courier select
// can be asserted to filter, exactly as the manufacturer select is.
const COURIERS = [
  {
    id: 'vndr_cour1',
    type: 'COURIER',
    displayName: 'Blue Dart',
    status: 'ACTIVE',
    courierCode: 'BD',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  ...MANUFACTURERS,
]

const COURIER_STATUS_RESULT = {
  fileId: 'file-9',
  advanced: 3,
  trailOnly: 1,
  quarantined: 2,
  invalid: 1,
  invalidRows: [{ rowNo: 5, errors: ['unparseable_status_date'] }],
  deduped: false,
}

const DEVICE_INVENTORY_RESULT = {
  fileId: 'file-3',
  accepted: 2,
  flagged: 1,
  invalid: 1,
  createdUnitIds: ['unit-1', 'unit-2'],
  invalidRows: [{ rowNo: 4, errors: ['missing_device_id'] }],
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

// The rail's "Choose file" pill navigates away from the page under test, so it
// needs the real router (UploadsPage's Routes), not a bare upload page mounted
// in isolation. Mirrors uploads-index.test.tsx's renderAt.
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/uploads/*" element={<UploadsPage />} />
        </Routes>
      </AuthProvider>
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

  // Ruling 2026-08-11: device inventory has no preview route on the edge at
  // all, so its rail is exactly three steps (Choose, Upload, Submit), the
  // shortest of the three surfaces, proving the rail adapts to what a file
  // actually needs rather than asserting a Review that would have nothing to
  // show.
  it('device inventory: the rail has NO Review step, and ends in Submit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(MANUFACTURERS)
        return jsonResponse({})
      }),
    )
    renderAt('/uploads/device-inventory')
    expect(await screen.findByText(/device inventory upload/i)).toBeTruthy()
    expect(screen.queryByText(/^review$/i)).toBeNull()
    expect(screen.getByText(/^submit$/i)).toBeTruthy()
  })

  it('device inventory: Continue needs BOTH a file and a manufacturer, and Submit is the confirm step', async () => {
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

    const continueButton = screen.getByRole('button', { name: /continue to submit/i }) as HTMLButtonElement
    expect(continueButton.disabled).toBe(true)

    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'inventory.csv'))
    // A file alone (no manufacturer yet) must not enable Continue, and
    // nothing is posted to the upload route merely from picking a file.
    expect(continueButton.disabled).toBe(true)
    expect(calls.some((c) => c.url.includes('/ops/uploads/device-inventory'))).toBe(false)

    await userEvent.selectOptions(select, 'vndr_manu1')
    expect(continueButton.disabled).toBe(false)

    await userEvent.click(continueButton)

    // Submit is the confirm step: the upload button lives here, not before,
    // and nothing has been posted by merely reaching it.
    const submitButton = (await screen.findByRole('button', { name: /upload device inventory file/i })) as HTMLButtonElement
    expect(submitButton.disabled).toBe(false)
    expect(calls.some((c) => c.url.includes('/ops/uploads/device-inventory'))).toBe(false)

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
    // rows, exactly what the server reported (row 4, missing_device_id, the
    // one row error code left since the 12 Aug 2026 walkthrough). The "2"
    // also matches the rail's own done-step digit, so the Accepted count
    // is read off its own definition-list value rather than a bare text
    // match, the same idiom the bank/damage tests use.
    const acceptedDd = (await screen.findByText('Accepted')).nextElementSibling as HTMLElement
    expect(acceptedDd.textContent).toBe('2')
    expect(screen.getByText('Missing Device Id')).toBeTruthy()
    const rowCell = screen.getByText('4')
    expect(rowCell).toBeTruthy()
  })

  // D-17 (T5.1): the fourth upload surface. The courier emails a spreadsheet
  // every morning and no vendor credential can authenticate an inbox.
  it('courier status: Continue needs BOTH a file and a courier, and Submit posts the named courier', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('/ops/vendors')) return jsonResponse(COURIERS)
        if (url.includes('/ops/uploads/courier-status')) return jsonResponse(COURIER_STATUS_RESULT)
        return jsonResponse({})
      }),
    )

    renderWithProviders(<CourierStatusUploadPage />)

    // Sourced from the REAL vendor read, filtered to COURIER: a manufacturer
    // must never be offerable as the sender of a status file.
    const select = (await screen.findByLabelText(/^courier$/i)) as HTMLSelectElement
    expect(within(select).getByText('Blue Dart')).toBeTruthy()
    expect(within(select).queryByText('Acme Devices')).toBeNull()

    const continueButton = screen.getByRole('button', { name: /continue to submit/i }) as HTMLButtonElement
    expect(continueButton.disabled).toBe(true)

    const input = screen.getByLabelText(/courier status file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('irrelevant, the server parses this', 'morning.csv'))
    expect(continueButton.disabled).toBe(true)
    expect(calls.some((c) => c.url.includes('/ops/uploads/courier-status'))).toBe(false)

    await userEvent.selectOptions(select, 'vndr_cour1')
    expect(continueButton.disabled).toBe(false)
    await userEvent.click(continueButton)

    const submitButton = (await screen.findByRole('button', { name: /upload courier status file/i })) as HTMLButtonElement
    expect(calls.some((c) => c.url.includes('/ops/uploads/courier-status'))).toBe(false)
    await userEvent.click(submitButton)

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/uploads/courier-status'))).toBe(true)
    })
    const uploadCall = calls.find((c) => c.url.includes('/ops/uploads/courier-status'))!
    expect(headerValue(uploadCall, 'Idempotency-Key')).toBeTruthy()
    const form = uploadCall.init.body as FormData
    expect(form.get('courierVndrId')).toBe('vndr_cour1')
  })

  it('courier status: the four outcomes are reported separately, because each is a different next action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/vendors')) return jsonResponse(COURIERS)
        if (url.includes('/ops/uploads/courier-status')) return jsonResponse(COURIER_STATUS_RESULT)
        return jsonResponse({})
      }),
    )

    renderWithProviders(<CourierStatusUploadPage />)
    const select = (await screen.findByLabelText(/^courier$/i)) as HTMLSelectElement
    await userEvent.upload(screen.getByLabelText(/courier status file/i), makeFile('x', 'morning.csv'))
    await userEvent.selectOptions(select, 'vndr_cour1')
    await userEvent.click(screen.getByRole('button', { name: /continue to submit/i }))
    await userEvent.click(await screen.findByRole('button', { name: /upload courier status file/i }))

    await waitFor(() => {
      expect(screen.getByText('Moved forward')).toBeTruthy()
    })
    // Read off each label's own value, never a bare number match: three of the
    // four counts here would collide with a digit somewhere else on the page.
    const valueOf = (label: string): string | null =>
      (screen.getByText(label).nextElementSibling as HTMLElement).textContent
    expect(valueOf('Moved forward')).toBe('3')
    expect(valueOf('Recorded only')).toBe('1')
    expect(valueOf('Held for review')).toBe('2')
    expect(valueOf('Rejected rows')).toBe('1')

    // A held row is not fixed by re-uploading, and the page says where it IS
    // fixed rather than leaving an operator to guess. The helper card below the
    // form says the same thing, hence getAll.
    expect(screen.getAllByText(/exceptions queue/i).length).toBeGreaterThan(0)
    // The row the FILE got wrong is named with its row number and its reason.
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.getByText('Unparseable Status Date')).toBeTruthy()
  })

  // D-19 (T5.5): the CWD's activation file. EVERY row comes back, including the
  // ones that did not activate, because the CWD reported an activation for each
  // line and an operator has to see what became of it.
  it('activation: every row comes back with its own outcome, activated or not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/uploads/activation'))
          return jsonResponse({
            activated: 1,
            invalid: 1,
            invalidRows: [{ rowNo: 3, errors: ['unsupported_status'] }],
            results: [
              { deviceId: 'SER-1', dispatchId: 'asgn_a', activated: true, reason: null },
              { deviceId: 'SER-2', dispatchId: '', activated: false, reason: 'unknown-device' },
            ],
          })
        return jsonResponse({})
      }),
    )

    renderWithProviders(<ActivationUploadPage />)

    await userEvent.upload(screen.getByLabelText(/activation file/i), makeFile('x', 'cwd.csv'))
    await userEvent.click(screen.getByRole('button', { name: /continue to submit/i }))
    await userEvent.click(await screen.findByRole('button', { name: /upload activation file/i }))

    // The one that worked and the one that did not, both named, in words. The
    // outcome is read off the row's own cell: "Activated" is also the count
    // label above the table.
    const okRow = (await screen.findByText('SER-1')).closest('tr')!
    expect(within(okRow).getByText('Activated')).toBeTruthy()
    expect(screen.getByText('SER-2')).toBeTruthy()
    expect(screen.getByText(/device not recognised/i)).toBeTruthy()
    // And the row the file itself was wrong about, separately, with its reason
    // in words rather than in the server's code vocabulary.
    expect(screen.getByText(/status is not a success/i)).toBeTruthy()
  })

  it('activation: a structural rejection names the column and no rows are claimed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/uploads/activation'))
          return jsonResponse(
            { message: 'activation file failed structural parse', reasons: [{ code: 'missing_required_column', column: 'Status' }] },
            400,
          )
        return jsonResponse({})
      }),
    )

    renderWithProviders(<ActivationUploadPage />)
    await userEvent.upload(screen.getByLabelText(/activation file/i), makeFile('x', 'cwd.csv'))
    await userEvent.click(screen.getByRole('button', { name: /continue to submit/i }))
    await userEvent.click(await screen.findByRole('button', { name: /upload activation file/i }))

    expect(await screen.findByText(/missing required column "Status"/i)).toBeTruthy()
    expect(screen.getByText(/no rows were read/i)).toBeTruthy()
  })

  it('device inventory upload: a file over 5 MB is rejected client-side and never posted', async () => {
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
        if (url.includes('/ops/uploads/device-inventory')) return jsonResponse(body, status)
        return jsonResponse({})
      }),
    )
    renderWithProviders(<DeviceInventoryUploadPage />)
    const select = (await screen.findByLabelText(/manufacturer/i)) as HTMLSelectElement
    const input = screen.getByLabelText(/device inventory file/i) as HTMLInputElement
    await userEvent.upload(input, makeFile('Device ID,Device QR\nD1,{}\n', 'cwd-export.csv'))
    await userEvent.selectOptions(select, 'vndr_manu1')
    await userEvent.click(screen.getByRole('button', { name: /continue to submit/i }))
    await userEvent.click(await screen.findByRole('button', { name: /upload device inventory file/i }))
  }

  it('device inventory upload: names the offending column when the header is wrong', async () => {
    // Device ID is the only column the server can report missing since the
    // 12 Aug 2026 walkthrough made the other two optional.
    await submitInventory(400, {
      code: 'invalid',
      message: 'invalid request',
      reasons: [{ code: 'missing_required_column', column: 'Device ID' }],
    })
    expect(await screen.findByText(/Missing required column "Device ID"/)).toBeTruthy()
    // The operator is also told what a valid file looks like, and that the
    // whole file was rejected rather than partially ingested.
    expect(screen.getByText(/Expected columns: Device ID/)).toBeTruthy()
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

    const continueButton = screen.getByRole('button', { name: /continue to submit/i }) as HTMLButtonElement
    const zone = screen.getByText(/Drop your file here/i).closest('div')!
    const dropped = makeFile('Device ID,Sim No,Device QR\n1,2,3\n', 'dropped-inventory.csv')

    fireEvent.drop(zone, { dataTransfer: { files: [dropped] } })

    // Staged: the file is named, sized, and the zone's idle prompt is gone.
    expect(await screen.findByText('dropped-inventory.csv')).toBeTruthy()
    expect(screen.getByText(/ready to upload/i)).toBeTruthy()
    expect(screen.queryByText(/Drop your file here/i)).toBeNull()

    // A manufacturer is still required, so a drop alone must not enable Continue.
    expect(continueButton.disabled).toBe(true)
    await userEvent.selectOptions(screen.getByLabelText(/manufacturer/i), 'vndr_manu1')
    expect(continueButton.disabled).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /remove file/i }))
    expect(await screen.findByText(/Drop your file here/i)).toBeTruthy()
    expect(continueButton.disabled).toBe(true)
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
  it('device inventory upload: going back to Upload after a structural rejection clears the stale rejection', async () => {
    await submitInventory(400, {
      code: 'invalid',
      message: 'invalid request',
      reasons: [{ code: 'missing_required_column', column: 'Device ID' }],
    })
    expect(await screen.findByText(/Missing required column "Device ID"/)).toBeTruthy()

    const railPill = (label: string) => new RegExp(`^\\d\\s*${label}$`, 'i')
    fireEvent.click(screen.getByRole('button', { name: railPill('upload') }))

    // Back at Upload: the stale rejection must not still be standing.
    expect(screen.queryByText(/Missing required column "Device ID"/)).toBeNull()

    // Continue again without picking a new file: still no stale rejection,
    // only the fresh confirm line.
    await userEvent.click(screen.getByRole('button', { name: /continue to submit/i }))
    expect(screen.queryByText(/Missing required column "Device ID"/)).toBeNull()
    expect(screen.getByText(/the file will be ingested/i)).toBeTruthy()
  })
})
