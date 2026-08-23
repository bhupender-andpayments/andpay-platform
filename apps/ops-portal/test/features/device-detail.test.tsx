import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

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
// UNPAIRED WAREHOUSE STOCK (24 Aug 2026): no dispatch owns it, so there is no
// Flag damage anywhere that could write it off. This is the one device the page
// may still change by hand, and the reason the control was narrowed rather than
// deleted: without it a crushed unit counts as available stock forever.
const STOCK_ROW = { ...ROW, id: 'unit_3', deviceSerial: '9990000001003', status: 'IN_STOCK', asgnId: null, shipment: null, batch: null, printedForMerchant: null }

// The device's status trail (STATUS_STAGES.md), which the rail is now built
// from. ROW is DISPATCHED, so its trail records the three rungs it passed and
// says nothing about Delivered, which is exactly what a rail should show as
// still ahead.
const TRAIL = [
  { status: 'IN_STOCK', occurredAt: '2026-08-10T09:00:00.000Z', statusSource: 'intake', actorId: null, recordedAt: '2026-08-10T09:00:01.000Z' },
  { status: 'PRINTED', occurredAt: '2026-08-11T09:00:00.000Z', statusSource: 'return-sheet', actorId: null, recordedAt: '2026-08-11T09:00:01.000Z' },
  { status: 'DISPATCHED', occurredAt: '2026-08-12T09:00:00.000Z', statusSource: 'return-sheet', actorId: null, recordedAt: '2026-08-12T09:00:01.000Z' },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(devices: unknown[] = [ROW, DAMAGED_ROW]): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url })
    if (url.includes('/ops/units/') && url.endsWith('/status')) return jsonResponse({ deduped: false, advanced: true })
    // BEFORE the /ops/devices arm below, which is a PREFIX of this path: the
    // list route would otherwise answer the trail request with device rows.
    if (url.includes('/ops/devices/') && url.endsWith('/trail')) return jsonResponse(TRAIL)
    if (url.includes('/ops/devices')) return jsonResponse(devices)
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

  // NO STATUS CONTROL AT ALL (24 Aug 2026, at the user's direction). Six tests
  // exercising a Change status dialog stood here; the dialog is deleted. Every
  // rung is written by the flow that owns it, so the page that DRAWS the
  // lifecycle no longer sets it: the batch's send, the vendor's return sheet,
  // the SHIPMENT (delivered, returned) and the dispatch's Flag damage (which
  // marks this device on the way through). Asserted as an absence because the
  // control was narrowed three times before being removed, and its return
  // should fail a test rather than reach a demo.
  it('offers no status control, on a paired device or on unpaired stock', async () => {
    for (const [id, row] of [
      ['unit_1', ROW],
      ['unit_3', STOCK_ROW],
      ['unit_2', DAMAGED_ROW],
    ] as const) {
      stub([row])
      renderAt(id, { row })
      await screen.findAllByText(row.deviceSerial!)
      expect(screen.queryByRole('button', { name: /change status/i })).toBeNull()
      expect(screen.queryByLabelText(/new status/i)).toBeNull()
      cleanup()
    }
  })

  // The ONE device-level write that survives: activation is its own axis, its
  // own column, and nothing else can set it.
  it('keeps the activation toggle, which is the only write this page owns', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getByRole('button', { name: /activate/i })).toBeTruthy()
  })

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
    // The per-device DETAIL route is what this guards (it is the only route
    // that serves the full ICCID and raw QR payload). Its SIBLINGS share the
    // prefix and are deliberately excluded: reading a status history, or the
    // replacement chain (23 Aug 2026, ids and serials only), is not reading the
    // detail record. The chain was given its own narrow route precisely so this
    // guard could stand.
    expect(
      calls.some(
        (c) =>
          c.url.includes('/ops/devices/unit_1') &&
          !c.url.endsWith('/trail') &&
          !c.url.endsWith('/replacement-chain'),
      ),
    ).toBe(false)
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
    expect(screen.getByText(/delivery follows its parcel/i)).toBeTruthy()
    // The whole spine renders, reached and future alike, so the operator sees
    // what is left as well as what is done. PRINTED displays as a place, not a
    // thing that happened to paper.
    for (const label of ['In stock', 'At print vendor', 'Delivered']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // AND NO ALLOCATED RUNG (19 Aug 2026). Nothing ever wrote that status, so a
    // rail that draws every earlier rung as reached was putting a green tick on a
    // stage this device had skipped. It is out of the domain spine now, not just
    // out of this rail.
    expect(screen.queryByText('Allocated')).toBeNull()
    // AND NOT AN ACTIVATED RUNG (19 Aug 2026). It was one until a demo showed
    // what that costs: an activated device whose delivery was still outstanding
    // drew "Delivered (not reached) -> Activated (done)", which is not a
    // sequence, and it contradicted the Change status dialog on this same page,
    // which correctly refuses to offer ACTIVATED at all. The axis is a header
    // pill now, asserted below.
    const rail = within(screen.getByRole('list', { name: /lifecycle rail/i }))
    expect(rail.queryByText('Activated')).toBeNull()
    expect(rail.queryByText(/not activated/i)).toBeNull()
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
    expect(screen.getAllByText(/not activated/i).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /mark damaged/i })).toBeNull()
  })

  // THE ACTIVATION AXIS, AS A HEADER PILL beside the status pill, matching the
  // inventory table's two columns (19 Aug 2026). Two pills, because the two
  // facts are independent: a device can be activated and not yet delivered, or
  // delivered and not yet activated, and one of those is a real worklist.
  it('states ONE composed status, not two competing pills', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')

    // STATUS_STAGES.md (21 Aug 2026): the two axes stay separate in storage,
    // but the SCREEN reads as one lifecycle, so this is one pill.
    //
    // It also retires a `NOT_ACTIVATED` pill that was never a backend value.
    // ROW is DISPATCHED and not activated, and on an undelivered device that
    // absence is unremarkable (nothing has reached the merchant yet), so the
    // pill simply says where the device is.
    const pills = screen.getAllByText(/not activated|dispatched/i).filter((el) => el.className.includes('pill'))
    expect(pills.map((p) => p.textContent)).toEqual(['Dispatched'])
  })

  // TWO PILLS, ONE PER AXIS (23 Aug 2026), reversing the composed COMPLETED
  // this page carried since 21 Aug.
  //
  // The composition was not wrong about the domain, but COMPLETED is a word the
  // platform stores nowhere, and it replaced the two values an operator is
  // actually reconciling against the CWD and the courier. The inventory list
  // has always shown them as two columns; the detail page now agrees with the
  // list rather than inventing a third vocabulary for the same device.
  it('says "not activated" beside the delivery pill, matching the list', async () => {
    stub()
    renderAt('unit_1', { row: { ...ROW, status: 'DELIVERED', activatedAt: null } })
    await screen.findAllByText('9990000001001')

    // More than one on purpose: the header states it beside the delivery pill,
    // and the Activity card states it again as the activation fact.
    expect(screen.getAllByText(/not activated/i).length).toBeGreaterThan(0)
    const pills = screen.getAllByText('Delivered').filter((el) => el.className.includes('pill'))
    expect(pills.length).toBeGreaterThan(0)
  })

  it('a DELIVERED and activated device shows BOTH pills, never a composed Completed', async () => {
    stub()
    renderAt('unit_1', { row: { ...ROW, status: 'DELIVERED', activatedAt: '2026-08-19T01:39:00.000Z' } })
    await screen.findAllByText('9990000001001')

    const pillTexts = (t: RegExp | string) => screen.getAllByText(t).filter((el) => el.className.includes('pill'))
    expect(pillTexts('Activated').length).toBeGreaterThan(0)
    expect(pillTexts('Delivered').length).toBeGreaterThan(0)
    // The composite must not reappear on this screen. deviceDisplayStatus still
    // exists for surfaces that want one word; this is not one of them.
    expect(screen.queryByText('Completed')).toBeNull()
  })

  it('an activated device shows the positive pill, whatever its delivery status is', async () => {
    stub()
    renderAt('unit_1', { row: { ...ROW, activatedAt: '2026-08-19T01:39:00.000Z' } })
    await screen.findAllByText('9990000001001')

    const pill = screen.getAllByText('Activated').find((el) => el.className.includes('pill'))
    expect(pill).toBeTruthy()
    // Still DISPATCHED on the delivery axis: activating moved nothing there.
    expect(within(screen.getByRole('list', { name: /lifecycle rail/i })).queryByText('Activated')).toBeNull()
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThanOrEqual(2)
  })

  it('a DAMAGED device shows the terminal stop, in plain words and with no release jargon', async () => {
    stub()
    renderAt('unit_2', { row: DAMAGED_ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.getAllByText('Damaged').length).toBeGreaterThanOrEqual(2)
    // No release-planning language on an operator screen (2026-08-12 review).
    expect(document.body.textContent).not.toMatch(/phase 1|phase 2/i)
  })

  // The Device card's pencil is GONE (2026-08-17 ruling): the page edits a
  // device's LIFECYCLE, and the intake-correction editor it opened was a
  // second, differently-shaped write sitting on the same screen. Status is the
  // only edit this page offers now.
  it('offers no device-details editor on the Device card', async () => {
    stub()
    renderAt('unit_1', { row: ROW })
    await screen.findAllByText('9990000001001')
    expect(screen.queryByRole('button', { name: /edit device details/i })).toBeNull()
  })

})
