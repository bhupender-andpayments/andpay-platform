import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { RequestDetailPage } from '../../src/features/requests/RequestDetailPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import type { RequestLegRow, ReportRow } from '../../src/api/endpoints.js'

// 23 Aug 2026: the request detail page. No dedicated backend route; it fetches
// the same GET /ops/requests list the RequestsPage does and narrows client-side
// to one sourceEventId, so these fixtures are the same RequestLegRow shape.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function leg(over: Partial<RequestLegRow> = {}): RequestLegRow {
  return {
    sourceEventId: 'ef80df3f-93f6-49cc-89c5-9c470416dc96|3',
    asgnId: 'asgn_soundbox1',
    dispatchGroup: 'SOUNDBOX',
    merchantDisplayName: 'Ravi Medical Store',
    bankReferenceCode: '3',
    bankDisplayName: 'Gujarat State Co-op Bank',
    branchCode: '112',
    vpaValue: 'ravi01@gscb',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    billable: true,
    demandState: 'received',
    caseStatus: null,
    replacementOfAsgnId: null,
    activatedAt: null,
    createdAt: '2026-08-23T02:18:00.000Z',
    contactName: 'Ravi Shankar',
    mobile: '9168493103',
    email: null,
    shipToAddress: 'PLOT 7 STATION ROAD, MANI NAGAR',
    city: 'AHMEDABAD',
    state: 'Gujarat',
    pincode: '380001',
    qrType: null,
    ...over,
  }
}

const LEGS: RequestLegRow[] = [leg(), leg({ asgnId: 'asgn_collateral1', dispatchGroup: 'COLLATERAL', soundbox: false })]

// The leg's STAGE comes from the same GET /ops/reports/dispatches rows the
// Dispatches list reads (pipeline_state, with the edge-merged hold overlay),
// never from TMS's demand_state: demand_state parks at pooled-for-fulfillment
// and does not hear about batching, which is exactly the desync this fixture
// exists to pin. Field names copied from the report's own row shape.
function reportRow(over: Partial<Record<string, unknown>> = {}): ReportRow {
  return {
    dispatchId: 'asgn_soundbox1',
    pipelineState: 'BATCHED',
    ...over,
  } as ReportRow
}

function renderDetail(sourceEventId: string, legs: RequestLegRow[] = LEGS, reportRows: ReportRow[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/ops/reports/dispatches'))
        return jsonResponse({ rows: reportRows, watermark: { asOf: null, perTopic: {} } })
      return jsonResponse(legs)
    }),
  )
  return render(
    <MemoryRouter
      initialEntries={[`/requests/${encodeURIComponent(sourceEventId)}`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <Routes>
          <Route path="/requests" element={<div>REQUESTS LIST PAGE</div>} />
          <Route path="/requests/:sourceEventId" element={<RequestDetailPage />} />
          <Route path="/dispatches/:asgnId" element={<div>DISPATCH DETAIL PAGE</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('RequestDetailPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('shows the request facts, including the BRD contact and address block', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    expect(await screen.findByText('Ravi Medical Store')).toBeTruthy()
    expect(screen.getByText(LEGS[0]!.sourceEventId)).toBeTruthy()
    expect(screen.getByText(/Gujarat State Co-op Bank/)).toBeTruthy()
    expect(screen.getByText('112')).toBeTruthy()
    expect(screen.getByText('ravi01@gscb')).toBeTruthy()
    expect(screen.getByText('Ravi Shankar')).toBeTruthy()
    expect(screen.getByText('9168493103')).toBeTruthy()
    expect(screen.getByText(/PLOT 7 STATION ROAD/)).toBeTruthy()
  })

  // THE OPS-FLAG ID (23 Aug 2026, at the user's correction). A damage flag has
  // no bank file behind it, so TMS mints a derived request key,
  // `ops-flag|<root bank key>|g<n>` (services/tms/src/flag-damage.ts). Printed
  // raw it read as noise nobody could parse; it is said in words now, with the
  // ROOT bank request still shown as the id it actually is.
  it('explains an ops-flag request id instead of printing it raw', async () => {
    const flagId = 'ops-flag|ef80df3f-93f6-49cc-89c5-9c470416dc96|2|g1'
    const legs = [leg({ sourceEventId: flagId, asgnId: 'asgn_repl1', replacementOfAsgnId: 'asgn_old1' })]
    renderDetail(flagId, legs)

    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText(/raised by an ops damage flag, replacement round 1/i)).toBeTruthy()
    // The ROOT bank request, as a real id.
    expect(screen.getByText('ef80df3f-93f6-49cc-89c5-9c470416dc96|2')).toBeTruthy()
    // And never the raw derived string.
    expect(screen.queryByText(flagId)).toBeNull()
  })

  it('shows an ordinary bank request id exactly as it is', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText(LEGS[0]!.sourceEventId)).toBeTruthy()
    expect(screen.queryByText(/ops damage flag/i)).toBeNull()
  })

  it('shows the kit requested', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText('Yes')).toBeTruthy() // Soundbox
    expect(screen.getByText('Legs in this request:')).toBeTruthy()
  })

  it('spells out a fact honestly rather than leaving it blank', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    // email and qrType are both null in the fixture, so this renders twice.
    expect(screen.getAllByText('not recorded').length).toBeGreaterThan(0)
  })

  it('renders one card per leg, Soundbox and Collateral', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText('Soundbox dispatch')).toBeTruthy()
    expect(screen.getByText('Collateral dispatch')).toBeTruthy()
    expect(screen.getByText('asgn_soundbox1')).toBeTruthy()
    expect(screen.getByText('asgn_collateral1')).toBeTruthy()
  })

  it('marks a leg as Replacement when it replaces another dispatch', async () => {
    renderDetail('src-repl', [leg({ sourceEventId: 'src-repl', replacementOfAsgnId: 'asgn_original9' })])
    await screen.findByText('Ravi Medical Store')
    // Renders twice: the header badge (the whole request is a replacement
    // round) and the leg card's own badge.
    expect(screen.getAllByText('Replacement').length).toBe(2)
  })

  // THE DESYNC REGRESSION (23 Aug 2026, found live). TMS's demand_state parks
  // at pooled-for-fulfillment and never hears about batching, so rendering it
  // here made this page say "Pooled" while the Dispatches list said "Batched"
  // for the same leg. The stage must come from the report's pipelineState.
  it('shows the leg at the stage the Dispatches list shows, not TMS demand_state', async () => {
    renderDetail(
      LEGS[0]!.sourceEventId,
      // demandState still says pooled; the report says the batch formed.
      LEGS.map((l) => ({ ...l, demandState: 'pooled-for-fulfillment' })),
      [reportRow({ dispatchId: 'asgn_soundbox1', pipelineState: 'BATCHED' })],
    )
    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText('Batched')).toBeTruthy()
    expect(screen.queryByText(/pooled.for.fulfillment/i)).toBeNull()
  })

  // Hold arrives on the SAME report rows (poolStatus/holdReason, merged at
  // the edge by mergeHoldState), so held-on-the-pool-page IS held here.
  it('shows a leg as Held, with its reason, when the report row is HELD', async () => {
    renderDetail(LEGS[0]!.sourceEventId, LEGS, [
      reportRow({ pipelineState: 'RECEIVED', poolStatus: 'HELD', holdReason: 'awaiting bank confirmation' }),
    ])
    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText('Held')).toBeTruthy()
    expect(screen.getByText('Held: awaiting bank confirmation')).toBeTruthy()
    // The underlying stage still reads underneath the HELD pill (the
    // collateral leg, absent from the report, falls back to Received too).
    expect(screen.getAllByText('Received').length).toBe(2)
  })

  it('says so honestly when a held leg carries no reason', async () => {
    renderDetail(LEGS[0]!.sourceEventId, LEGS, [reportRow({ poolStatus: 'HELD', holdReason: null })])
    await screen.findByText('Ravi Medical Store')
    expect(screen.getByText('Held, no reason recorded.')).toBeTruthy()
  })

  it('does not mark a leg Held when the report row carries no hold overlay', async () => {
    renderDetail(LEGS[0]!.sourceEventId, LEGS, [reportRow({ pipelineState: 'RECEIVED' })])
    await screen.findByText('Ravi Medical Store')
    expect(screen.queryByText('Held')).toBeNull()
  })

  // A leg analytics has not projected yet has no report row at all. That must
  // read as Received (where a seconds-old request truly is), never as an
  // error or a hold.
  it('falls back to Received for a leg with no report row', async () => {
    renderDetail(LEGS[0]!.sourceEventId, LEGS, [])
    await screen.findByText('Ravi Medical Store')
    expect(screen.getAllByText('Received').length).toBe(2)
    expect(screen.queryByText('Held')).toBeNull()
  })

  // REGRESSION (23 Aug 2026): a collateral leg never activates, so "Not
  // activated" on it asserted something false. It shows what it actually
  // carries instead.
  it('shows standee and sticker counts on the Collateral leg, never an activation claim', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    const collateralCard = screen.getByText('Collateral dispatch').closest('button')
    expect(collateralCard).not.toBeNull()
    expect(collateralCard!.textContent).toContain('1 standee, 2 stickers')
    expect(collateralCard!.textContent).not.toMatch(/activat/i)
  })

  it('shows activation status on the Soundbox leg', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    const soundboxCard = screen.getByText('Soundbox dispatch').closest('button')
    expect(soundboxCard).not.toBeNull()
    expect(soundboxCard!.textContent).toContain('Not activated yet')
  })

  it('opens the real dispatch detail page when a leg card is clicked', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    await userEvent.click(screen.getByText('Soundbox dispatch'))
    expect(await screen.findByText('DISPATCH DETAIL PAGE')).toBeTruthy()
  })

  it('returns to the Requests list from the back link', async () => {
    renderDetail(LEGS[0]!.sourceEventId)
    await screen.findByText('Ravi Medical Store')
    await userEvent.click(screen.getByText('Requests'))
    expect(await screen.findByText('REQUESTS LIST PAGE')).toBeTruthy()
  })

  it('says so honestly when no request carries this source event id', async () => {
    renderDetail('src-does-not-exist', LEGS)
    expect(await screen.findByText(/request not found/i)).toBeTruthy()
  })

  it('survives a non-array body instead of taking down the page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ unexpected: true })))
    render(
      <MemoryRouter
        initialEntries={[`/requests/${encodeURIComponent(LEGS[0]!.sourceEventId)}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <Routes>
            <Route path="/requests/:sourceEventId" element={<RequestDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/request not found/i)).toBeTruthy()
  })

  it('renders an error note when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'boom', message: 'nope' }, 500)))
    render(
      <MemoryRouter
        initialEntries={[`/requests/${encodeURIComponent(LEGS[0]!.sourceEventId)}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <Routes>
            <Route path="/requests/:sourceEventId" element={<RequestDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
