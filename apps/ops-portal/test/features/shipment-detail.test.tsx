import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, cleanup, within } from '@testing-library/react'
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
        return jsonResponse({ rows: [{ dispatchId: 'asgn_1', shptId: SHPT, awb: 'AWB900002', merchantDisplay: 'ALPHA STORE' }], watermark: { asOf: null, perTopic: {} } })
      }
      return jsonResponse({})
    }),
  )
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/shipments/${SHPT}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/shipments/:shptId" element={<ShipmentDetailPage />} />
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
      <MemoryRouter initialEntries={[`/shipments/${SHPT}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Routes>
            <Route path="/shipments/:shptId" element={<ShipmentDetailPage />} />
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
    // findAll, not find: 'Picked up' is now a RAIL RUNG as well as a trail row
    // (19 Aug 2026), which is the point of that change. The two clocks below are
    // what distinguishes the trail row from the rung.
    expect((await screen.findAllByText(/picked up/i)).length).toBeGreaterThan(0)
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

    expect((await screen.findAllByText(/picked up/i)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/No courier updates yet/i)).toBeNull()
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
          return jsonResponse({ rows: [{ dispatchId: 'asgn_1', shptId: SHPT, awb: 'AWB900002', merchantDisplay: 'ALPHA STORE' }], watermark: { asOf: null, perTopic: {} } })
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

    // The join is still in flight, so neither negative may be on screen. The
    // settled empty state is the centered EmptyState; mid-load must show the
    // plain "Loading the courier history" sentence instead.
    expect(screen.queryByText(/No dispatch is joined/i)).toBeNull()
    expect(screen.queryByText(/No courier updates yet/i)).toBeNull()
    expect(screen.getByText(/Loading the courier history/i)).toBeTruthy()

    releaseDetail!()

    // Once it lands, the join renders.
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    expect((await screen.findAllByText(/picked up/i)).length).toBeGreaterThan(0)
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
    // The centered EmptyState, once the reads have settled (18 Aug 2026): a
    // half-height card beside a full one read as unfinished rather than as an
    // empty answer.
    expect(screen.getByText(/No courier updates yet/i)).toBeTruthy()
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

  // THE 18 Aug 2026 CORRECTION. Shpt carries no foreign key back to a
  // dispatch at all; the link is owned from the OTHER side (unit.shipment,
  // pending_pool_entry.collateral_shipment), so several dispatches can
  // legitimately share one AWB, a consolidated pickup being the ordinary
  // case. The page used to keep only the FIRST report row matching this shpt
  // id, so a 6-dispatch AWB silently showed one parcel.
  it('lists every dispatch on the AWB, not just the first one matched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/dispatches')) return jsonResponse([SHIPMENT])
        if (url.includes('/ops/vendors')) return jsonResponse([])
        if (url.includes('/ops/reports/soundbox-delivery')) {
          return jsonResponse({
            rows: [
              { dispatchId: 'asgn_1', shptId: SHPT, awb: 'AWB900002', merchantDisplay: 'ALPHA STORE' },
              { dispatchId: 'asgn_2', shptId: SHPT, awb: 'AWB900002', merchantDisplay: 'BETA STORE' },
              { dispatchId: 'asgn_3', shptId: SHPT, awb: 'AWB900002', merchantDisplay: 'GAMMA STORE' },
              // A DIFFERENT AWB's row must never leak into this shipment's list.
              { dispatchId: 'asgn_other', shptId: 'shpt_other', awb: 'AWB900099', merchantDisplay: 'DELTA STORE' },
            ],
            watermark: { asOf: null, perTopic: {} },
          })
        }
        if (url.includes('/ops/reports/dispatch/')) return jsonResponse(DISPATCH)
        return jsonResponse({})
      }),
    )
    renderPage()

    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    expect(screen.getByText('BETA STORE')).toBeTruthy()
    expect(screen.getByText('GAMMA STORE')).toBeTruthy()
    expect(screen.queryByText('DELTA STORE')).toBeNull()
    expect(screen.getByRole('link', { name: /asgn_1/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /asgn_2/ })).toBeTruthy()
    expect(screen.getByRole('link', { name: /asgn_3/ })).toBeTruthy()
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

  // 19 Aug 2026: the rung map here listed only the three rung NAMES, and anything
  // absent from it was drawn as an off-ladder red stop. PICKED_UP and
  // OUT_FOR_DELIVERY are ordinary courier statuses that THIS PAGE'S OWN
  // correction dialog offers, so recording either one turned a live parcel into a
  // failure with a warning triangle. The map is shared with the dispatch page now
  // (features/dispatches/dispatchStatus.ts), which is what stops the same hole
  // being reopened in one page and not the other.
  it('a parcel at PICKED_UP sits on the handover rung, not off the ladder', async () => {
    stub([{ ...SHIPMENT, status: 'PICKED_UP' }])
    renderPage()

    expect(await screen.findByText('Shipment lifecycle')).toBeTruthy()
    // PICKED_UP HAS ITS OWN RUNG (19 Aug 2026). It first drew as a red terminal
    // failure (absent from the rung map, and absence was the test for
    // off-ladder), then correctly but confusingly as the handover rung it had
    // been folded onto. This page owns the courier axis, so it shows all five of
    // the service's ladder statuses and what the operator picked is what lights
    // up.
    const rail = within(screen.getByRole('list', { name: /lifecycle rail/i }))
    expect(rail.getByText('Picked up').className).not.toContain('text-muted-foreground')
    expect(rail.getByText('Dispatched by vendor').className).not.toContain('text-muted-foreground')
    // Everything ahead of it is still ahead of it, and nothing is a red stop.
    for (const label of ['In transit', 'Out for delivery', 'Delivered']) {
      expect(rail.getByText(label).className).toContain('text-muted-foreground')
    }
    expect(rail.queryByText('Failed')).toBeNull()
  })

  it('RETURNED is still drawn as a terminal stop, which is the case the map must not swallow', async () => {
    stub([{ ...SHIPMENT, status: 'RETURNED' }])
    renderPage()

    expect(await screen.findByText('Returned to origin')).toBeTruthy()
  })
})
