import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
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

// The SAME page as the real app mounts it. `main.tsx` wraps everything in
// <StrictMode>, which double-invokes every effect: run, clean up, run again.
// The plain render above never exercised that, and the join this page is built
// around was lost by exactly that double-invoke in production (18 Aug 2026).
function renderPageStrict() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/dispatches/shipment/${SHPT}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Routes>
            <Route path="/dispatches/shipment/:shptId" element={<ShipmentDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </StrictMode>,
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

  // THE REGRESSION (18 Aug 2026). Under StrictMode the parcel facts rendered but
  // the owning dispatch never did: the page said "No dispatch is joined to this
  // AWB in the reporting rail" and "No courier updates for this AWB yet" while
  // the report row and the detail read had both answered 200. Asserting the join
  // and the trail together, because they are the same failure: the trail is read
  // off the dispatch, so losing the dispatch empties the carrier history too.
  it('keeps the dispatch join and the carrier trail under StrictMode', async () => {
    stub()
    renderPageStrict()

    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    expect(screen.getByRole('link', { name: /asgn_1/ })).toBeTruthy()
    expect(screen.queryByText(/No dispatch is joined/i)).toBeNull()

    expect(await screen.findByText(/picked up/i)).toBeTruthy()
    expect(screen.queryByText(/No courier updates for this AWB yet/i)).toBeNull()
  })

  // THE REAL DEFECT behind the 18 Aug 2026 report, and the reason it was first
  // mis-filed as a state bug: the join and the trail are TWO CHAINED reads
  // (the delivery report to find the owning dispatch, then that dispatch's
  // detail), and until they settle this page asserted two definitive negatives.
  // Against the shared RDS that window is over a second, measured at 450ms
  // showing both messages and at 4.5s showing neither, so an operator glancing
  // at a parcel mid-load was TOLD it had no dispatch and no courier history.
  // A pending read is not an absent dispatch, and must not read as one.
  it('does not claim the parcel has no dispatch or no courier history while the join is still loading', async () => {
    let releaseDetail: (() => void) | null = null
    const detailHeld = new Promise<void>((resolve) => {
      releaseDetail = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/dispatches')) return jsonResponse([SHIPMENT])
        if (url.includes('/ops/vendors')) return jsonResponse([])
        if (url.includes('/ops/reports/soundbox-delivery')) {
          return jsonResponse({ rows: [{ dispatchId: 'asgn_1', shptId: SHPT, awb: 'AWB900002' }], watermark: { asOf: null, perTopic: {} } })
        }
        if (url.includes('/ops/reports/dispatch/')) {
          await detailHeld
          return jsonResponse(DISPATCH)
        }
        return jsonResponse({})
      }),
    )

    renderPage()

    // The parcel's own facts come from the shipment list and are already up.
    expect(await screen.findByRole('heading', { name: 'AWB900002' })).toBeTruthy()

    // The join is still in flight, so neither negative may be on screen.
    expect(screen.queryByText(/No dispatch is joined/i)).toBeNull()
    expect(screen.queryByText(/No courier updates for this AWB yet/i)).toBeNull()

    releaseDetail!()

    // Once it lands, the join renders.
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    expect(await screen.findByText(/picked up/i)).toBeTruthy()
  })

  // The negatives are still the right answer once the reads HAVE settled and the
  // parcel genuinely carries no dispatch, which is the collateral-only case the
  // message was written for.
  it('still says no dispatch is joined once the report has settled with no owning row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/dispatches')) return jsonResponse([SHIPMENT])
        if (url.includes('/ops/vendors')) return jsonResponse([])
        if (url.includes('/ops/reports/soundbox-delivery')) {
          // No row carries this shptId: a collateral-only parcel.
          return jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })
        }
        return jsonResponse({})
      }),
    )

    renderPage()

    expect(await screen.findByText(/No dispatch is joined/i)).toBeTruthy()
    expect(screen.getByText(/No courier updates for this AWB yet/i)).toBeTruthy()
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
