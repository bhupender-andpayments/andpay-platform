import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { InventoryPage } from '../../src/features/inventory/InventoryPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The inventory workspace (2026-08-12 ownership handoff): stat cards over a
// filter toolbar over a paginated grid. Everything on the screen is computed
// from ONE fetched list, so cards and table can never disagree.
//
// The SIM arrives IN FULL from the server: this is an internal admin console,
// not a merchant-facing one, and masking it (then gating the real value behind
// a Reveal click) was overturned the same day it shipped - the operator's
// whole reason for looking is to cross-check it against the source Excel.

const DEVICE = {
  id: 'unit_1',
  deviceSerial: '9990000001001',
  // D-16 (T4.4): the two axes at once, and deliberately in the shape the old
  // ladder could not express. This device is still with the courier AND already
  // activated by the CWD.
  status: 'DISPATCHED',
  activatedAt: '2026-08-02T09:00:00.000Z',
  productType: 'SOUNDBOX',
  manufacturerVndr: 'vndr_1',
  batch: 'btch_1',
  shipment: 'shpt_1',
  printedForMerchant: 'mrch_1',
  asgnId: 'asgn_1',
  location: null,
  simNo: '89910000123456789',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
}
const IN_STOCK = {
  ...DEVICE,
  id: 'unit_2',
  deviceSerial: '9990000001002',
  status: 'IN_STOCK',
  // BOTH axes on the fixture: activatedAt because D-16 split activation off the
  // status ladder, simNo because migration 20260812150000 put the SIM on the
  // list. A fixture missing either one stops standing in for the real read.
  activatedAt: null,
  batch: null,
  shipment: null,
  printedForMerchant: null,
  asgnId: null,
  simNo: null,
}
const MERCHANTS = [{ mrchId: 'mrch_1', displayName: 'Flow Alpha Store', legalName: 'FLOW ALPHA LLP', mcc: '5411', status: 'ACTIVE', updatedAt: '2026-08-01T00:00:00.000Z' }]
const VENDORS = [
  { id: 'vndr_1', type: 'MANUFACTURER', displayName: 'CWD Devices', status: 'ACTIVE', courierCode: null, integrationMode: null },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(devices: unknown = [DEVICE, IN_STOCK]): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url })
    if (url.includes('/ops/merchants')) return jsonResponse(MERCHANTS)
    if (url.includes('/ops/vendors')) return jsonResponse(VENDORS)
    if (url.includes('/ops/damage-cases')) return jsonResponse([])
    return jsonResponse(devices)
  }))
  return calls
}

function renderPage(initialEntry = '/inventory') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/inventory/upload" element={<div>upload home</div>} />
          <Route path="/inventory/device/:unitId" element={<div>device detail page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('InventoryPage', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('lists devices from GET /ops/devices, which nothing could read before', async () => {
    const calls = stub()
    renderPage()
    expect(await screen.findByText('9990000001001')).toBeTruthy()
    expect(screen.getByText('9990000001002')).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/ops/devices'))).toBe(true)
  })

  // Q4, ruled 12 Aug 2026: the `unit_` wire id IS the system-generated Soundbox
  // ID (Workflow A step 4), so the screen must show it rather than keeping it
  // internal. Both ids are shown because they answer different questions: ours
  // and the manufacturer's serial.
  it('shows the Soundbox ID (the unit wire id) alongside the manufacturer Device ID', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('unit_1')).toBeTruthy()
    expect(screen.getByText('unit_2')).toBeTruthy()
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toContain('Soundbox ID')
    // Device ID stays first: it is what an operator reads off the box.
    expect(headers.indexOf('Device ID')).toBeLessThan(headers.indexOf('Soundbox ID'))
  })

  // A card's accessible name is its whole content (label, number, hint), so
  // the number is asserted inside the name itself: "In stock 1 ...".
  it('answers the stock question in cards: total, in stock, and the rest of the lifecycle', async () => {
    stub()
    renderPage()
    expect(await screen.findByRole('button', { name: /^total devices 2\b/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^in stock 1\b/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^activated 1\b/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^damaged 0\b/i })).toBeTruthy()
  })

  it('shows the full SIM number directly, no masking', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('89910000123456789')).toBeTruthy()
  })

  it('resolves the merchant NAME rather than showing a wire id', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('Flow Alpha Store')).toBeTruthy()
    expect(screen.queryByText('mrch_1')).toBeNull()
  })

  it('resolves the manufacturer NAME rather than showing a wire id', async () => {
    stub()
    renderPage()
    expect((await screen.findAllByText('CWD Devices')).length).toBeGreaterThan(0)
  })

  it('says "unassigned" for a device no merchant owns yet, not an empty cell', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('unassigned')).toBeTruthy()
  })

  // Filtering is CLIENT-SIDE over the one fetched list (aggregates and filter
  // params stay out of ops-read): choosing a status narrows the table without
  // another network call, and the choice lands in the URL so the view is
  // shareable.
  it('filters by status client-side via the multi-select', async () => {
    stub()
    renderPage()
    await screen.findByText('9990000001001')
    // The Field's <label htmlFor> gives the trigger the accessible name
    // "Status"; its visible summary text is the reliable handle.
    await userEvent.click(screen.getByText(/all statuses/i))
    await userEvent.click(await screen.findByRole('checkbox', { name: /in stock/i }))
    await vi.waitFor(() => {
      expect(screen.queryByText('9990000001001')).toBeNull()
    })
    expect(screen.getByText('9990000001002')).toBeTruthy()
  })

  // ALLOCATED is reachable by nothing today. It is still offered because the
  // rung exists in unit-lifecycle.ts, and a filter that silently disagreed with
  // the domain would be its own small lie. ACTIVATED, by contrast, is GONE from
  // this list on purpose (D-16, T4.4): it stopped being a value `status` can
  // take, and leaving it would return an empty list forever while implying the
  // platform had lost every activated device.
  it('offers every delivery status, in lifecycle order, and no longer offers ACTIVATED', async () => {
    stub()
    renderPage()
    await screen.findByText('9990000001001')
    await userEvent.click(screen.getByText(/all statuses/i))
    // Scoped to the popover's own listbox: the manufacturer select and the
    // grid's rows-per-page select also expose option roles.
    const listbox = await screen.findByRole('listbox')
    const options = within(listbox).getAllByRole('option')
    // No 'Activated'. This is the assertion D-16 turns on, and it is made
    // against the real control rather than the <select> an earlier version of
    // this screen had.
    expect(options.map((o) => o.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'In stock', 'Allocated', 'Printed', 'Dispatched', 'Delivered', 'Damaged', 'Returned',
    ])
  })

  it('shows the delivery axis and the activation axis as separate columns', async () => {
    stub()
    renderPage()
    // The row reads Dispatched and Activated at the same time, which is the
    // whole of D-16 on one line. Scoped to the ROW, because "Activated" also
    // appears on the stat card above the table, and the pill renders the LABEL
    // rather than the raw enum.
    const row = (await screen.findByText('9990000001001')).closest('tr')!
    expect(within(row).getByText('Dispatched')).toBeTruthy()
    expect(within(row).getByText('Activated')).toBeTruthy()
  })

  it('says "not activated" rather than leaving the cell blank, which could mean not loaded', async () => {
    stub([{ ...DEVICE, activatedAt: null }])
    renderPage()
    expect(await screen.findByText(/not activated/i)).toBeTruthy()
  })

  it('clicking a stat card applies its status slice, and clicking again clears it', async () => {
    stub()
    renderPage()
    await screen.findByText('9990000001001')
    const inStockCard = screen.getByRole('button', { name: /^in stock 1\b/i })
    await userEvent.click(inStockCard)
    await vi.waitFor(() => {
      expect(screen.queryByText('9990000001001')).toBeNull()
    })
    await userEvent.click(inStockCard)
    expect(await screen.findByText('9990000001001')).toBeTruthy()
  })

  it('paginates: the footer states the visible range out of the total', async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      ...IN_STOCK,
      id: `unit_m${i}`,
      deviceSerial: `88800000010${String(i).padStart(2, '0')}`,
    }))
    stub(many)
    renderPage()
    expect(await screen.findByText(/1-10 of 23/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(await screen.findByText(/11-20 of 23/)).toBeTruthy()
  })

  it('navigates to the device detail page on row click', async () => {
    stub()
    renderPage()
    await userEvent.click(await screen.findByText('9990000001001'))
    expect(await screen.findByText(/device detail page/i)).toBeTruthy()
  })

  it('offers Upload inventory as the section-owned entry point', async () => {
    stub()
    renderPage()
    await screen.findByText('9990000001001')
    await userEvent.click(screen.getByRole('button', { name: /upload inventory/i }))
    expect(await screen.findByText(/upload home/i)).toBeTruthy()
  })

  it('distinguishes "filters match nothing" from "nothing in stock yet"', async () => {
    stub()
    renderPage('/inventory?q=doesnotexist')
    expect(await screen.findByText(/no devices match these filters/i)).toBeTruthy()
    stub([])
    cleanup()
    renderPage()
    expect(await screen.findByText(/no devices in stock yet/i)).toBeTruthy()
  })

  it('survives a non-array body instead of taking the page down with it', async () => {
    stub({ error: 'nope' })
    renderPage()
    expect(await screen.findByText(/could not read the device list/i)).toBeTruthy()
  })
})
