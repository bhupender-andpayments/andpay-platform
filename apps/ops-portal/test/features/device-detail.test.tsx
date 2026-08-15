import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DeviceDetailPage } from '../../src/features/inventory/DeviceDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The per-device page, redesigned 2026-08-14: a horizontal lifecycle rail owns
// the top, three fact cards (Device, Assignment, Activity) sit under it.
//
// THE QR CARD IS GONE, and with it the GET /ops/devices/:unitId detail read this
// page used to fire on mount. A raw payload blob nobody eyeballs was taking a
// card's worth of space on the page an operator opens to check a device's
// progress. The tests below assert that read no longer happens, so it cannot
// creep back in unnoticed.
//
// TWO EDIT ACTIONS, and they stay separate: "Change status" on the rail (a
// lifecycle move), the Device card's pencil (a correction to what intake
// recorded). There is no third "Mark damaged" button anymore - DAMAGED is one of
// the choices "Change status" already offers.

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
  activatedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
}
const DAMAGED_ROW = { ...ROW, id: 'unit_2', status: 'DAMAGED' }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url })
    if (url.includes('/ops/units/') && url.endsWith('/status')) return jsonResponse({ deduped: false, advanced: true })
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

  it('never reads the per-device detail route, and shows no QR payload', async () => {
    const calls = stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    expect(calls.some((c) => c.url.includes('/ops/devices/unit_1'))).toBe(false)
    expect(screen.queryByText(/upi:\/\//)).toBeNull()
    expect(document.body.textContent).not.toMatch(/qr payload/i)
  })

  it('recovers the row from the LIST read on a direct URL', async () => {
    const calls = stub()
    renderAt('unit_1')
    expect((await screen.findAllByText('9990000001001')).length).toBeGreaterThan(0)
    expect(calls.some((c) => c.url.includes('/ops/devices'))).toBe(true)
  })

  it('says plainly when no such device exists', async () => {
    stub()
    renderAt('unit_nonexistent')
    expect(await screen.findByText(/no device with this id exists/i)).toBeTruthy()
  })

  it('shows the lifecycle rail with every rung, and states the forward-only rule', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getByText(/only moves forward/i)).toBeTruthy()
    // The whole spine renders, reached and future alike, so the operator sees
    // what is left as well as what is done. PRINTED displays as a place, not a
    // thing that happened to paper. Activated is the ladder's end for a
    // device: a rail rung read off the activation axis, not a status.
    for (const label of ['In stock', 'Allocated', 'At print vendor', 'Delivered', 'Activated']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // "Dispatched" is deliberately on screen more than once: the header pill,
    // the current rung, and the Activity card's current-status fact.
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThanOrEqual(2)
  })

  it('shows the three fact cards, and no Mark damaged shortcut', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getByText('Device')).toBeTruthy()
    expect(screen.getByText('Assignment')).toBeTruthy()
    expect(screen.getByText('Activity')).toBeTruthy()
    // Activation is its own axis, reported here rather than as a rung.
    expect(screen.getByText(/not activated/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /mark damaged/i })).toBeNull()
  })

  it('a DAMAGED device shows the terminal stop, in plain words and with no release jargon', async () => {
    stub()
    renderAt('unit_2', { row: DAMAGED_ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getAllByText('Damaged').length).toBeGreaterThanOrEqual(2)
    // No release-planning language on an operator screen (2026-08-12 review).
    expect(document.body.textContent).not.toMatch(/phase 1|phase 2/i)
  })

  // Manual status edit (2026-08-13): forward-only, mirroring the server's own
  // canAdvanceUnitStatus rule. DISPATCHED can move to DELIVERED, DAMAGED or
  // RETURNED, never back to IN_STOCK/ALLOCATED/PRINTED. ACTIVATED is absent on
  // purpose (D-16): it is not a unit status, and the server would reject it.
  it('the edit dialog offers only forward-legal statuses from the current one', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    await userEvent.click(screen.getByRole('button', { name: /change status/i }))
    await userEvent.click(await screen.findByLabelText(/new status/i))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Delivered', 'Damaged', 'Returned'])
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
    // The dialog closes and "Delivered" now appears more than once (the pill and
    // the Activity card's fact join the rung label that was already there).
    expect(screen.queryByLabelText(/new status/i)).toBeNull()
    expect(screen.getAllByText('Delivered').length).toBeGreaterThan(1)
  })

  // The other half of the two-action split: correcting what the intake file
  // recorded, from the Device card's own pencil.
  it('the device-details pencil opens the field editor and posts only what changed', async () => {
    const calls = stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    await userEvent.click(screen.getByRole('button', { name: /edit device details/i }))
    const sim = await screen.findByLabelText('SIM')
    await userEvent.clear(sim)
    await userEvent.type(sim, '89910000000000999999')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/units/unit_1/edit'))).toBe(true)
    })
    expect(screen.getByText('89910000000000999999')).toBeTruthy()
  })
})
