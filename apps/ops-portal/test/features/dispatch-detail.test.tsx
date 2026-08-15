import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchDetailPage } from '../../src/features/dispatches/DispatchDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The per-dispatch detail page: ONE horizontal rail over the BRD delivery
// ladder, no activation (2026-08-15 ruling: parcels deliver, devices activate,
// and the device page owns that axis). The response shape below mirrors the
// edge's dispatchDetail route (apps/ops-edge/src/reports.controller.ts);
// nothing is invented here.

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
    { status: 'PICKED_UP', courierTimestamp: '2026-08-12T09:00:00.000Z', statusSource: 'courier-file', sourceRef: 'vndr_1|file_7', receivedAt: '2026-08-12T09:05:00.000Z', overrideReason: null },
    { status: 'IN_TRANSIT', courierTimestamp: '2026-08-12T15:00:00.000Z', statusSource: 'courier-file', sourceRef: 'vndr_1|file_8', receivedAt: '2026-08-12T15:04:00.000Z', overrideReason: null },
  ],
  activationTrail: [
    { status: 'REQUEST_SENT_TO_CWD', occurredAt: '2026-08-12T10:00:00.000Z', statusSource: 'ops:request-activation', actorId: null, recordedAt: '2026-08-12T10:00:30.000Z' },
    { status: 'ACTIVATED', occurredAt: '2026-08-12T12:00:00.000Z', statusSource: 'ops:mark-activated', actorId: null, recordedAt: '2026-08-12T12:00:20.000Z' },
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

  it('renders the delivery ladder as one rail, and no activation anywhere on the page', async () => {
    stub(DETAIL)
    renderPage()

    expect(await screen.findByText('Dispatch lifecycle')).toBeTruthy()
    for (const label of [
      'Received',
      'Pending batch',
      'QR generated',
      'Sent to print vendor',
      'Dispatched by vendor',
      'Delivered',
    ]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    // In transit is the current rung AND the header pill, so it appears twice.
    expect(screen.getAllByText(/in transit/i).length).toBeGreaterThan(0)

    // A dispatch does not activate; its devices do, on the device page. The
    // activation trail the read still carries must render nowhere here.
    expect(screen.queryByText(/activation/i)).toBeNull()
    expect(screen.queryByText(/request sent to cwd/i)).toBeNull()
    expect(screen.queryByText(/^activated$/i)).toBeNull()
  })

  it('an activated device does not move the parcel: the rail stays on the courier axis', async () => {
    stub(DETAIL)
    renderPage()

    // The read says ACTIVATED (12:00) while the parcel is IN_TRANSIT (15:00).
    // The rail reports the parcel, so In transit is where it stands and no
    // delivery instant is claimed.
    expect((await screen.findAllByText(/in transit/i)).length).toBeGreaterThan(0)
    expect(screen.getByText('Delivered')).toBeTruthy()
    // The Delivered FactRow answers honestly.
    expect(screen.getByText('not yet')).toBeTruthy()
  })

  it('a COLLATERAL dispatch renders the same ladder with no activation apology card', async () => {
    stub({ ...DETAIL, dispatchGroup: 'COLLATERAL', activationStatus: null, activationDate: null, activationTrail: [] })
    renderPage()

    expect(await screen.findByText('Dispatch lifecycle')).toBeTruthy()
    // The old page had to explain that paper does not activate. With activation
    // gone from this page there is nothing to apologise for.
    expect(screen.queryByText(/collateral does not activate/i)).toBeNull()
    expect(screen.queryByText(/activation/i)).toBeNull()
  })

  it('a dispatch the courier has not touched still shows the whole ladder, early rungs reached', async () => {
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

    // The BRD's first rungs are real positions this dispatch has reached, and
    // the courier rungs ahead are drawn unreached rather than hidden.
    expect(await screen.findByText('Received')).toBeTruthy()
    expect(screen.getByText('Pending batch')).toBeTruthy()
    expect(screen.getByText('Delivered')).toBeTruthy()
    // The AWB fact answers honestly instead of claiming a parcel.
    expect(screen.getByText('not dispatched')).toBeTruthy()
  })

  // WHAT WAS ASKED FOR, which the analytics read does not carry. The page fetches
  // it from the batch that holds this dispatch, so the quantities and the UPI ID
  // an operator asks about are on screen without a new backend route.
  it('shows the ordered quantities and the UPI ID, taken from the batch that holds this dispatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/batches/')) {
          return jsonResponse({
            batch: { id: 'btch_1', triggerReason: 'MANUAL', unitCount: 1, printVndr: null, triggeredByActor: null, triggerNote: null, createdAt: '2026-08-12T08:00:00.000Z', updatedAt: '2026-08-12T08:00:00.000Z' },
            entries: [{ asgnId: ASGN, merchantDisplayName: 'ALPHA', merchantLegalName: 'ALPHA LLP', bankReferenceCode: '3', bankDisplayName: 'GSCB', branchCode: '30', soundbox: true, standeeCount: 2, stickerCount: 4, poolStatus: 'BATCHED', dispatchState: 'SENT_TO_VENDOR', shipToSuperseded: false, dispatchGroup: 'SOUNDBOX' }],
            artifacts: [{ asgnId: ASGN, artifactType: 'STANDEE_IMG', assetReference: 's3://x', supersededAt: null, labelQr: 'upi://pay?pa=alpha@gscb&pn=ALPHA', labelDisplayName: 'ALPHA' }],
            printLayout: 'ONE_PER_PAGE',
          })
        }
        if (url.includes('/ops/devices')) return jsonResponse([])
        return jsonResponse({ ...DETAIL, batchId: 'btch_1' })
      }),
    )
    renderPage()

    expect(await screen.findByText(/Soundbox, 2 standee, 4 sticker/i)).toBeTruthy()
    expect(await screen.findByText('alpha@gscb')).toBeTruthy()
    // The branch code comes from the same row, and the batch is a link to the
    // page that owns it: nothing here asks the operator to copy an id.
    expect(screen.getByText('30')).toBeTruthy()
    expect(screen.getByRole('link', { name: /btch_1/ }).getAttribute('href')).toBe('/batches/btch_1')
  })

  it('names the bank as the requester, because a soundbox request comes from a bank and not a person', async () => {
    stub(DETAIL)
    renderPage()
    expect(await screen.findByText(/requested by/i)).toBeTruthy()
    expect(screen.getByText(/HDFC Bank/)).toBeTruthy()
  })

  it('survives a failed read instead of taking the page down with it', async () => {
    stub({ error: 'nope' }, 500)
    renderPage()
    expect(await screen.findByText(/could not read this dispatch/i)).toBeTruthy()
  })
})
