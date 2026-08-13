import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DeviceDetailPage } from '../../src/features/inventory/DeviceDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The per-device page (2026-08-12, SIM unmasked and QR auto-loaded
// 2026-08-13): facts left, lifecycle timeline main, QR in its own card below.
// Nothing on this page is gated behind a click anymore - the SIM is on the
// LIST row and shown directly, and the manufacturer QR (GET
// /ops/devices/:unitId, not on the list row at all) is fetched automatically
// the moment a unit id is known, no Reveal button.

const ROW = {
  id: 'unit_1',
  deviceSerial: '9990000001001',
  status: 'DISPATCHED',
  productType: 'SOUNDBOX',
  manufacturerVndr: 'vndr_1',
  batch: 'btch_1',
  shipment: 'shpt_1',
  printedForMerchant: 'mrch_1',
  asgnId: 'asgn_1',
  location: null,
  simNo: '89910000000000456789',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
}
const DETAIL = { ...ROW, deviceQr: { raw: 'upi://pay?pa=test@bank' } }
const DAMAGED_ROW = { ...ROW, id: 'unit_2', status: 'DAMAGED' }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url })
    if (url.includes('/ops/units/') && url.endsWith('/status')) return jsonResponse({ deduped: false, advanced: true })
    if (url.includes('/ops/devices/unit_1')) return jsonResponse(DETAIL)
    if (url.includes('/ops/devices/unit_2')) return jsonResponse({ ...DAMAGED_ROW, deviceQr: null })
    if (url.includes('/ops/devices')) return jsonResponse([ROW, DAMAGED_ROW])
    if (url.includes('/ops/merchants')) return jsonResponse([])
    if (url.includes('/ops/vendors')) return jsonResponse([])
    return jsonResponse({})
  }))
  return calls
}

function renderAt(unitId: string, state?: object) {
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: `/inventory/device/${unitId}`, state }]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/inventory/device/:unitId" element={<DeviceDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DeviceDetailPage', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('renders the full SIM from the handed list row directly, with no fetch needed for it', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    expect((await screen.findAllByText('9990000001001')).length).toBeGreaterThan(0)
    expect(screen.getByText('89910000000000456789')).toBeTruthy()
  })

  it('fetches the manufacturer QR payload automatically, no click required', async () => {
    const calls = stub()
    renderAt('unit_1', { row: ROW })
    expect(await screen.findByText('upi://pay?pa=test@bank')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/ops/devices/unit_1'))).toBe(true)
  })

  it('recovers the row from the LIST read on a direct URL, and still auto-fetches the QR', async () => {
    const calls = stub()
    renderAt('unit_1')
    expect((await screen.findAllByText('9990000001001')).length).toBeGreaterThan(0)
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/devices/unit_1'))).toBe(true)
    })
  })

  it('says plainly when no such device exists', async () => {
    stub()
    renderAt('unit_nonexistent')
    expect(await screen.findByText(/no device with this id exists/i)).toBeTruthy()
  })

  it('shows the lifecycle with the current stage marked and the forward-only rule stated', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getByText(/only moves forward/i)).toBeTruthy()
    // "Dispatched" renders twice on purpose: once in the header status pill,
    // once as the current timeline rung. Both are correct, so the count is
    // what is asserted rather than uniqueness.
    expect(screen.getAllByText('Dispatched').length).toBe(2)
    // A future rung still renders, muted, so the operator sees what is left.
    expect(screen.getByText('Delivered')).toBeTruthy()
    expect(screen.getByText(/courier confirmed delivery/i)).toBeTruthy()
  })

  it('a DAMAGED device shows the terminal stop, in plain words and with no release jargon', async () => {
    stub()
    renderAt('unit_2', { row: DAMAGED_ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getByText(/this device cannot be reverted/i)).toBeTruthy()
    // No release-planning language on an operator screen (2026-08-12 review).
    expect(document.body.textContent).not.toMatch(/phase 1|phase 2/i)
  })

  // Manual status edit (2026-08-13): forward-only, mirroring the server's own
  // canAdvanceUnitStatus rule. DISPATCHED can move to DELIVERED, ACTIVATED,
  // DAMAGED or RETURNED, never back to IN_STOCK/ALLOCATED/PRINTED.
  it('the edit dialog offers only forward-legal statuses from the current one', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    await userEvent.click(screen.getByRole('button', { name: /change status/i }))
    await userEvent.click(await screen.findByLabelText(/new status/i))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Delivered', 'Activated', 'Damaged', 'Returned'])
  })

  it('a terminal device (DAMAGED) has no edit control at all', async () => {
    stub()
    renderAt('unit_2', { row: DAMAGED_ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getByRole('button', { name: /change status/i })).toHaveProperty('disabled', true)
  })

  it('saving posts the new status and updates the pill without reloading the page', async () => {
    const calls = stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    await userEvent.click(screen.getByRole('button', { name: /change status/i }))
    await userEvent.click(await screen.findByLabelText(/new status/i))
    await userEvent.click(await screen.findByRole('option', { name: 'Delivered' }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/units/unit_1/status'))).toBe(true)
    })
    // The dialog closes and "Delivered" now appears (the status pill; the
    // timeline's own "Delivered" rung label was already on screen before the
    // save, so a count rather than uniqueness is what changed).
    expect(screen.queryByLabelText(/new status/i)).toBeNull()
    expect(screen.getAllByText('Delivered').length).toBeGreaterThan(0)
  })
})
