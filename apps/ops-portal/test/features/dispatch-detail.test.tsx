import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchDetailPage } from '../../src/features/dispatches/DispatchDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// D-16 (T4.5): the per-dispatch detail page renders the TWO BRANCHES, not one
// ladder. The response shape below mirrors the edge's dispatchDetail route
// (apps/ops-edge/src/reports.controller.ts), which composes it from analytics,
// fulfillment and tms; nothing is invented here.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const ASGN = 'asgn_01kzwrejswe5hvfjazjgfh01q6'

// The shape the old ladder could not hold: the CWD confirmed at 12:00 while the
// parcel was still in transit at 15:00.
const DETAIL = {
  dispatchId: ASGN,
  dispatchGroup: 'SOUNDBOX',
  bankCode: 'HDFC',
  bankDisplay: 'HDFC Bank',
  merchantDisplay: 'Flow Alpha Store',
  deviceIds: ['SB-1'],
  batchId: 'btch_1',
  awb: 'AWB-D1',
  shptId: 'shpt_1',
  dispatchDate: '2026-08-12T08:00:00.000Z',
  courierStatus: 'IN_TRANSIT',
  deliveryDate: null,
  activationStatus: 'ACTIVATED',
  activationDate: '2026-08-12T12:00:00.000Z',
  deliveryTrail: [
    { status: 'PICKED_UP', courierTimestamp: '2026-08-12T09:00:00.000Z', statusSource: 'courier-file', overrideReason: null },
    { status: 'IN_TRANSIT', courierTimestamp: '2026-08-12T15:00:00.000Z', statusSource: 'courier-file', overrideReason: null },
  ],
  activationTrail: [
    { status: 'REQUEST_SENT_TO_CWD', occurredAt: '2026-08-12T10:00:00.000Z', statusSource: 'ops:request-activation', actorId: null },
    { status: 'ACTIVATED', occurredAt: '2026-08-12T12:00:00.000Z', statusSource: 'ops:mark-activated', actorId: null },
  ],
  watermark: { asOf: '2026-08-12T16:00:00.000Z', perTopic: {} },
}

function stub(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body, status)))
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/dispatches/${ASGN}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dispatches/:asgnId" element={<DispatchDetailPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DispatchDetailPage (D-16, T4.5)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders delivery and activation as SEPARATE branches, each with its own history', async () => {
    stub(DETAIL)
    renderPage()

    const delivery = await screen.findByTestId('delivery-branch')
    const activation = screen.getByTestId('activation-branch')

    // Each branch shows its OWN current state, off its own axis. Both branches
    // repeat their latest status in the trail below the heading, so these are
    // getAll: the point is that the token appears on ONE side, not how often.
    expect(within(delivery).getAllByText('IN_TRANSIT').length).toBeGreaterThan(0)
    expect(within(activation).getAllByText('ACTIVATED').length).toBeGreaterThan(0)

    // And its own trail. The request-sent event exists only on the activation
    // side, which is how you can tell they were not merged into one timeline.
    expect(within(activation).getByText('REQUEST_SENT_TO_CWD')).toBeTruthy()
    expect(within(delivery).queryByText('REQUEST_SENT_TO_CWD')).toBeNull()
    expect(within(delivery).getByText('PICKED_UP')).toBeTruthy()
    // And the delivery side knows nothing about activation.
    expect(within(delivery).queryByText('ACTIVATED')).toBeNull()
  })

  it('shows an activated record whose parcel has NOT arrived, without either branch contradicting the other', async () => {
    stub(DETAIL)
    renderPage()

    // Activated, and still in transit, at the same time. Under the old single
    // ladder one of these two readings had to lose.
    const activation = await screen.findByTestId('activation-branch')
    expect(within(activation).getAllByText('ACTIVATED').length).toBeGreaterThan(0)
    expect(within(screen.getByTestId('delivery-branch')).getAllByText('IN_TRANSIT').length).toBeGreaterThan(0)
    // No delivery date is claimed.
    expect(screen.queryByText(/^Delivered /)).toBeNull()
  })

  it('a COLLATERAL dispatch says paper does not activate rather than showing an empty queue', async () => {
    stub({ ...DETAIL, dispatchGroup: 'COLLATERAL', activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()

    expect(await screen.findByText(/collateral does not activate/i)).toBeTruthy()
    // "No events recorded yet" would read as "we are waiting", which for a
    // standee is never true.
    expect(screen.queryByText(/no events recorded yet/i)).toBeNull()
  })

  it('an empty branch says nothing has happened yet, which is a real answer and not a failure', async () => {
    stub({
      ...DETAIL,
      awb: null,
      shptId: null,
      courierStatus: null,
      deliveryTrail: [],
      activationStatus: null,
      activationTrail: [],
    })
    renderPage()

    expect(await screen.findByText('Not dispatched')).toBeTruthy()
    expect(screen.getByText('Not requested')).toBeTruthy()
    expect(screen.getAllByText(/no events recorded yet/i)).toHaveLength(2)
  })

  it('survives a failed read instead of taking the page down with it', async () => {
    stub({ error: 'nope' }, 500)
    renderPage()
    expect(await screen.findByText(/could not read this dispatch/i)).toBeTruthy()
  })
})
