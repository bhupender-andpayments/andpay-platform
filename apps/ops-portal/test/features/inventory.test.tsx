import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { InventoryPage } from '../../src/features/inventory/InventoryPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The device inventory, closing the largest gap the end-to-end walkthrough
// found: `unit` carries the whole device lifecycle and no ops surface could
// read it, so devices in the warehouse appeared on no screen at all and a
// device could not be looked up.
//
// The ICCID and the manufacturer QR payload are absent BY GRANT, not by this
// component, so there is nothing here to assert about them beyond the fact that
// the wire shape has no field for either.

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
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
}
const IN_STOCK = { ...DEVICE, id: 'unit_2', deviceSerial: '9990000001002', status: 'IN_STOCK', activatedAt: null, batch: null, shipment: null, printedForMerchant: null, asgnId: null }
const MERCHANTS = [{ mrchId: 'mrch_1', displayName: 'Flow Alpha Store', legalName: 'FLOW ALPHA LLP', mcc: '5411', status: 'ACTIVE', updatedAt: '2026-08-01T00:00:00.000Z' }]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(devices: unknown = [DEVICE, IN_STOCK]): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url })
    if (url.includes('/ops/merchants')) return jsonResponse(MERCHANTS)
    return jsonResponse(devices)
  }))
  return calls
}

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <InventoryPage />
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

  it('says how many are in stock, which is the question the warehouse asks', async () => {
    stub()
    renderPage()
    expect(await screen.findByText(/2 devices, 1 in stock/)).toBeTruthy()
  })

  it('resolves the merchant NAME rather than showing a wire id', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('Flow Alpha Store')).toBeTruthy()
    expect(screen.queryByText('mrch_1')).toBeNull()
  })

  it('says "unassigned" for a device no merchant owns yet, not an empty cell', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('unassigned')).toBeTruthy()
  })

  it('filters by status and sends it to the server', async () => {
    const calls = stub()
    renderPage()
    await screen.findByText('9990000001001')
    await userEvent.selectOptions(screen.getByLabelText(/^status/i), 'IN_STOCK')
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('status=IN_STOCK'))).toBe(true)
    })
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
    const select = (await screen.findByLabelText(/^status/i)) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual([
      '', 'IN_STOCK', 'ALLOCATED', 'PRINTED', 'DISPATCHED', 'DELIVERED', 'DAMAGED', 'RETURNED',
    ])
  })

  it('shows the delivery axis and the activation axis as separate columns', async () => {
    stub()
    renderPage()
    // The row reads DISPATCHED and Activated at the same time, which is the
    // whole of D-16 on one line.
    expect(await screen.findByText('DISPATCHED')).toBeTruthy()
    expect(await screen.findByText('Activated')).toBeTruthy()
  })

  it('says "not activated" rather than leaving the cell blank, which could mean not loaded', async () => {
    stub([{ ...DEVICE, activatedAt: null }])
    renderPage()
    expect(await screen.findByText(/not activated/i)).toBeTruthy()
  })

  it('survives a non-array body instead of taking the page down with it', async () => {
    stub({ error: 'nope' })
    renderPage()
    expect(await screen.findByText(/could not read the device list/i)).toBeTruthy()
  })
})
