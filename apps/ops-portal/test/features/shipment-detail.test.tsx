import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ShipmentDetailPage } from '../../src/features/dispatches/ShipmentDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// One AWB's own page. The carrier axis is the only lifecycle in this platform
// with a genuine append-only trail, so unlike a dispatch's early rungs every row
// here is a real event with the courier's reported instant AND ours.

const SHPT = 'shpt_01kzxvmqvnf84b4amjkprg4kpw'

const SHIPMENT = {
  id: SHPT,
  awb: 'AWB900002',
  status: 'IN_TRANSIT',
  courierPartner: 'vndr_courier_1',
  dispatchDate: '2026-08-12T09:00:00.000Z',
  statusAt: '2026-08-13T10:00:00.000Z',
  statusSource: 'BATCH_FILE',
  hasUnits: true,
  hasCollateral: false,
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z',
}

const DISPATCH = {
  dispatchId: 'asgn_1',
  dispatchGroup: 'SOUNDBOX',
  bankCode: '3',
  bankDisplay: 'GSCB',
  merchantDisplay: 'ALPHA STORE',
  deviceIds: [],
  batchId: null,
  awb: 'AWB900002',
  shptId: SHPT,
  dispatchDate: '2026-08-12T09:00:00.000Z',
  courierStatus: 'IN_TRANSIT',
  deliveryDate: null,
  activationStatus: null,
  activationDate: null,
  deliveryTrail: [
    {
      status: 'PICKED_UP',
      courierTimestamp: '2026-08-12T10:00:00.000Z',
      statusSource: 'BATCH_FILE',
      sourceRef: 'vndr_1|file_3',
      receivedAt: '2026-08-12T10:30:00.000Z',
      overrideReason: null,
    },
    {
      status: 'IN_TRANSIT',
      courierTimestamp: '2026-08-13T09:00:00.000Z',
      statusSource: 'BATCH_FILE',
      sourceRef: 'vndr_1|file_4',
      receivedAt: '2026-08-13T09:20:00.000Z',
      overrideReason: null,
    },
  ],
  activationTrail: [],
  watermark: { asOf: null, perTopic: {} },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(shipments: unknown[] = [SHIPMENT]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/ops/dispatches')) return jsonResponse(shipments)
      if (url.includes('/ops/vendors')) return jsonResponse([{ id: 'vndr_courier_1', type: 'COURIER', displayName: 'BlueDart', status: 'ACTIVE', courierCode: 'BD', createdAt: '', updatedAt: '' }])
      if (url.includes('/ops/reports/dispatch/')) return jsonResponse(DISPATCH)
      if (url.includes('/ops/reports/soundbox-delivery')) {
        return jsonResponse({ rows: [{ dispatchId: 'asgn_1', shptId: SHPT, awb: 'AWB900002' }], watermark: { asOf: null, perTopic: {} } })
      }
      return jsonResponse({})
    }),
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/dispatches/shipment/${SHPT}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dispatches/shipment/:shptId" element={<ShipmentDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('ShipmentDetailPage', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('names the parcel by its AWB and resolves the courier to a name', async () => {
    stub()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'AWB900002' })).toBeTruthy()
    expect(await screen.findByText('BlueDart')).toBeTruthy()
    expect(screen.getByText('Devices')).toBeTruthy()
  })

  it('renders the carrier trail as real events, keeping BOTH clocks', async () => {
    stub()
    renderPage()
    // Every courier row carries the instant the courier reported and the instant
    // we recorded it: a backdated file import must not look like a live webhook.
    expect(await screen.findByText(/picked up/i)).toBeTruthy()
    expect(screen.getAllByText(/reported/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/recorded/i).length).toBeGreaterThan(0)
  })

  it('walks back to the dispatch that owns the parcel', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    const link = screen.getByRole('link', { name: /asgn_1/ })
    expect(link.getAttribute('href')).toBe('/dispatches/asgn_1')
  })

  it('says an unknown id names no shipment rather than rendering an empty parcel', async () => {
    stub([])
    renderPage()
    expect(await screen.findByText(/no such shipment/i)).toBeTruthy()
  })

  // One button by default. The routine write (forward-only, same ladder as the
  // file) is always offered; the guard-bypassing Override appears ONLY when the
  // parcel sits at a terminal status, the one situation the routine tool
  // cannot act on.
  it('offers Record courier update, and hides Override while the parcel is mid-ladder', async () => {
    stub()
    renderPage()
    expect(await screen.findByRole('button', { name: /record courier update/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /override/i })).toBeNull()
  })

  it('shows Override once the parcel is at a terminal status', async () => {
    stub([{ ...SHIPMENT, status: 'DELIVERED' }])
    renderPage()
    expect(await screen.findByRole('button', { name: /override/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /record courier update/i })).toBeTruthy()
  })

  it('summarises the courier ladder as a rail above the detailed trail', async () => {
    stub()
    renderPage()
    expect(await screen.findByText('Shipment lifecycle')).toBeTruthy()
    // The three ladder rungs render whatever the parcel has reached; the
    // detailed two-clock history keeps living below, not replaced by the rail.
    expect(screen.getByText('Dispatched by vendor')).toBeTruthy()
    expect(screen.getAllByText(/in transit/i).length).toBeGreaterThan(0)
    expect(screen.getByText('Delivered')).toBeTruthy()
    expect(screen.getByText('Carrier history')).toBeTruthy()
  })
})
