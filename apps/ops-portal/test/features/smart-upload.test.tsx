import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { SmartUploadPage } from '../../src/features/uploads/SmartUploadPage.js'
import { UploadsPage } from '../../src/features/uploads/UploadsPage.js'
import { ReturnUploadPage } from '../../src/features/uploads/ReturnUploadPage.js'
import { DeviceInventoryUploadPage } from '../../src/features/uploads/DeviceInventoryUploadPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { takeStagedFile } from '../../src/lib/stagedFile.js'

// Task 10: one dropzone, sniff-based routing. The route map (services doc,
// Task 10 brief): return-sheet -> /uploads/return, courier-status ->
// /uploads/courier-status, activation -> /uploads/activation, bank ->
// /uploads/bank, device-inventory -> /inventory/upload. `unit-status` has no
// dedicated page, so it is never auto-landed on, single candidate or not.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeFile(content: string, name: string, type = 'text/csv'): File {
  return new File([content], name, { type })
}

function stubSniff(candidates: string[], calls: Call[] = []): Call[] {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/ops/uploads/sniff')) return jsonResponse({ candidates })
      if (url.includes('/ops/uploads/return/preview')) {
        return jsonResponse({
          structuralErrors: [],
          validRows: [{ asgnId: 'asgn_1', awb: 'AWB1', deviceSerial: '869123450000001', courierCode: 'BD' }],
          invalidRows: [],
        })
      }
      if (url.includes('/ops/vendors')) {
        return jsonResponse([{ id: 'vndr_1', displayName: 'ACME MANUFACTURER', type: 'MANUFACTURER' }])
      }
      if (url.includes('/ops/uploads/device-inventory/preview')) {
        return jsonResponse({
          rows: [{ rowNo: 1, deviceId: 'DEV-1', simNo: '', deviceQr: '', errors: [], duplicateInFile: false, alreadyInStock: false, simAlreadyUsed: false }],
          totalRows: 1,
          willAdd: 1,
          willFlag: 0,
          willReject: 0,
        })
      }
      return jsonResponse({})
    }),
  )
  return calls
}

function renderSmartHarness(initialEntry = '/uploads/smart') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/uploads/smart" element={<SmartUploadPage />} />
          <Route path="/uploads/return" element={<ReturnUploadPage />} />
          <Route path="/uploads/activation" element={<div>activation upload page</div>} />
          <Route path="/uploads/courier-status" element={<div>courier status upload page</div>} />
          <Route path="/uploads/bank" element={<div>bank upload page</div>} />
          <Route path="/inventory/upload" element={<div>inventory upload page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

// The real DeviceInventoryUploadPage at /inventory/upload rather than the
// placeholder div: Finding 1 needs the actual consuming page mounted to prove
// the staged file both routes there AND lands staged, not just that the URL
// changed.
function renderSmartHarnessWithRealInventoryPage(initialEntry = '/uploads/smart') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/uploads/smart" element={<SmartUploadPage />} />
          <Route path="/uploads/return" element={<ReturnUploadPage />} />
          <Route path="/inventory/upload" element={<DeviceInventoryUploadPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

function renderUploadsPageAt(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/uploads/*" element={<UploadsPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

async function pickFile(file: File): Promise<void> {
  await userEvent.upload(screen.getByLabelText(/file to upload/i), file)
}

describe('smart upload page', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
    takeStagedFile()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders one dropzone and the four kind links', async () => {
    renderSmartHarness()
    expect(await screen.findByRole('heading', { name: /^upload a file$/i })).toBeTruthy()
    expect(screen.getByLabelText(/file to upload/i)).toBeTruthy()
    for (const name of [/bank file/i, /return sheet/i, /courier status/i, /activation file/i]) {
      expect(screen.getByRole('link', { name })).toBeTruthy()
    }
  })

  it('a single unambiguous candidate stages the file and navigates, with the staged preview visible', async () => {
    stubSniff(['return-sheet'])
    renderSmartHarness()

    await pickFile(makeFile('x', 'return-sheet.csv'))

    // Lands on the return page, and the staged file already fired its
    // preview (Task 9's wiring), with no further interaction here.
    expect(await screen.findByText(/print vendor return/i)).toBeTruthy()
    expect(await screen.findByText('return-sheet.csv')).toBeTruthy()
  })

  it('the four kind links navigate to their pages', async () => {
    renderSmartHarness()
    await userEvent.click(screen.getByRole('link', { name: /bank file/i }))
    expect(await screen.findByText(/bank upload page/i)).toBeTruthy()
  })

  it('a collision renders two labeled choices with no navigation; choosing activation navigates', async () => {
    const calls = stubSniff(['activation', 'unit-status'])
    renderSmartHarness()

    await pickFile(makeFile('x', 'ambiguous.csv'))

    const activationChoice = await screen.findByRole('button', { name: /^activation results from cwd$/i })
    const deviceStatusChoice = screen.getByRole('button', { name: /^device status file$/i })
    expect(activationChoice).toBeTruthy()
    expect(deviceStatusChoice).toBeTruthy()

    // No navigation happened: still on the smart page.
    expect(screen.queryByText(/activation upload page/i)).toBeNull()
    expect(calls.some((c) => c.url.includes('/uploads/activation'))).toBe(false)

    await userEvent.click(activationChoice)
    expect(await screen.findByText(/activation upload page/i)).toBeTruthy()
  })

  it('choosing the device status file in a collision shows an InfoNote and does not navigate, and the choice buttons stay so the operator can change their mind', async () => {
    stubSniff(['activation', 'unit-status'])
    renderSmartHarness()

    await pickFile(makeFile('x', 'ambiguous.csv'))
    await userEvent.click(await screen.findByRole('button', { name: /^device status file$/i }))

    expect(await screen.findByRole('link', { name: /inventory device flow/i })).toBeTruthy()
    expect(screen.queryByText(/activation upload page/i)).toBeNull()

    // Both choice buttons are still on screen beside the InfoNote: nothing
    // here should force a re-drop just to pick the other kind.
    const activationChoice = screen.getByRole('button', { name: /^activation results from cwd$/i })
    expect(activationChoice).toBeTruthy()
    expect(screen.getByRole('button', { name: /^device status file$/i })).toBeTruthy()

    await userEvent.click(activationChoice)
    expect(await screen.findByText(/activation upload page/i)).toBeTruthy()
  })

  it('empty candidates render an ErrorNote naming the four expected formats', async () => {
    stubSniff([])
    renderSmartHarness()

    await pickFile(makeFile('x', 'unknown.csv'))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toMatch(/bank request/i)
    expect(alert.textContent).toMatch(/return sheet/i)
    expect(alert.textContent).toMatch(/courier status/i)
    expect(alert.textContent).toMatch(/cwd activation/i)
  })

  it('bare /uploads redirects to /uploads/smart', async () => {
    renderUploadsPageAt('/uploads')
    expect(await screen.findByRole('heading', { name: /^upload a file$/i })).toBeTruthy()
  })

  // Finding 1: a device-inventory candidate routes to the real
  // DeviceInventoryUploadPage, and that page must actually consume the staged
  // file (stage it into its own dropzone and preview it), not merely receive
  // navigation while the file is silently dropped.
  it('a device-inventory candidate navigates to /inventory/upload and the file arrives staged there', async () => {
    stubSniff(['device-inventory'])
    renderSmartHarnessWithRealInventoryPage()

    await pickFile(makeFile('x', 'devices.csv'))

    expect(await screen.findByText('Device inventory upload')).toBeTruthy()
    // The staged file landed in this page's own dropzone and its mount-time
    // consume ran the same handler a direct drop would: the preview fired.
    expect(await screen.findByText('devices.csv')).toBeTruthy()
    expect(await screen.findByText(/1 row in this file/i)).toBeTruthy()
  })

  // Finding 1's leak: SmartUploadPage must discard an un-consumed staged file
  // on unmount, so a drop that never lands (the operator navigates away, or
  // the smart page is torn down, before a candidate lands on its own page)
  // cannot leak into whatever upload page mounts next and auto-fire against a
  // file that page never received a real drop or navigation for.
  //
  // `stageFile` is called directly here rather than through a full sniff
  // round trip: it stands in for "a drop just staged this file", which is
  // exactly the state SmartUploadPage is in the instant before `land()` runs.
  // What is under test is the unmount cleanup itself (1b): a file sitting in
  // the module-level slot when SmartUploadPage goes away without having
  // called `land()` must not survive to the next page's mount.
  it('a staged file that never lands through this page does not leak into the next upload page mounted', async () => {
    const { stageFile } = await import('../../src/lib/stagedFile.js')
    stageFile(makeFile('x', 'devices.csv'))

    const { unmount } = renderSmartHarness()
    await screen.findByRole('heading', { name: /^upload a file$/i })
    unmount()

    const calls = stubSniff([])

    render(
      <MemoryRouter initialEntries={['/uploads/return']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Routes>
            <Route path="/uploads/return" element={<ReturnUploadPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    // Give the mount effect a tick to fire if it were going to auto-consume a
    // leaked file and fire a preview request.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.some((c) => c.url.includes('/ops/uploads/return/preview'))).toBe(false)
    expect(screen.queryByText('devices.csv')).toBeNull()
  })
})
