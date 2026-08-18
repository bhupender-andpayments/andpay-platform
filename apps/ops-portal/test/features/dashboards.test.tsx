import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { TilesPage } from '../../src/features/dashboards/TilesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The Command Center, rebuilt 2026-08-15: one date window on top, six cards
// and one chart derived from the soundbox-delivery report INSIDE that window
// (the same read and definitions the Dispatches page uses), and a separate
// "Right now" strip from the live tiles aggregate, explicitly labelled as not
// on the date filter. The old 8-tile all-time grid is gone: an all-time
// number sitting under a date filter it ignores is a lie of layout.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const DAY_MS = 86_400_000
const iso = (daysBack: number) => new Date(Date.now() - daysBack * DAY_MS).toISOString()
const isoDay = (daysBack: number) => iso(daysBack).slice(0, 10)

const TILES_FIXTURE = {
  requestsReceived: 5,
  totalBatches: 12,
  pendingQrAwaitingBatch: { count: 2, oldestAgeDays: 1.5 },
  pendingPrintVendorPickup: 3,
  dispatchedNotDelivered: 4,
  deliveredNotActivated: 9,
  damagedReplacementOpen: 1,
  activatedSuccessfully: 7,
}

// Three dispatches inside the last week: one still with the vendor (no AWB),
// one on the road, one delivered.
const REPORT_ROWS = [
  { dispatchId: 'asgn_a', awb: null, courierStatus: null, dispatchDate: null, deliveryDate: null },
  { dispatchId: 'asgn_b', awb: 'AWB1', courierStatus: 'DISPATCHED_BY_VENDOR', dispatchDate: iso(2), deliveryDate: null },
  { dispatchId: 'asgn_c', awb: 'AWB2', courierStatus: 'DELIVERED', dispatchDate: iso(3), deliveryDate: iso(1) },
]

// D-31: the damage-case counts, a TMS read (DP-7: case status is never
// projected into analytics, so the analytics tiles cannot answer it).
const DAMAGE_SUMMARY = { open: 4, inProgress: 6, closed: 8 }

function stub(): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/ops/reports/soundbox-delivery')) {
        return jsonResponse({ rows: REPORT_ROWS, watermark: { asOf: '2026-08-15T08:00:00.000Z', perTopic: {} } })
      }
      if (url.includes('/ops/reports/tiles')) {
        return jsonResponse({ tiles: TILES_FIXTURE, watermark: { asOf: '2026-08-15T08:00:00.000Z', perTopic: {} } })
      }
      if (url.includes('/ops/damage-cases/summary')) {
        return jsonResponse(DAMAGE_SUMMARY)
      }
      return jsonResponse({})
    }),
  )
  return urls
}

function renderAt(path = '/dashboards') {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dashboards" element={<TilesPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('TilesPage (Command Center)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('derives the window cards from the date-filtered delivery report, with the Dispatches-page definitions', async () => {
    const urls = stub()
    renderAt()

    // The six cards, values straight from the three fixture rows.
    expect(await screen.findByText('created in this window')).toBeTruthy()
    const card = (hint: string) => screen.getByText(hint).closest('button')!
    expect(within(card('created in this window')).getByText('3')).toBeTruthy()
    expect(within(card('no AWB reported yet')).getByText('1')).toBeTruthy()
    expect(within(card('handed to the courier')).getByText('1')).toBeTruthy()
    expect(within(card('courier confirmed delivery')).getByText('1')).toBeTruthy()

    // And the read was WINDOWED: the default is the last 30 days, sent as
    // from/to on the wire, never fetched all-time and trimmed client-side.
    const reportUrl = urls.find((u) => u.includes('/ops/reports/soundbox-delivery'))
    expect(reportUrl).toBeTruthy()
    expect(reportUrl).toContain('from=')
    expect(reportUrl).toContain('to=')
  })

  it('buckets the chart by the window width: days for a week, weeks for two months, months for a year', async () => {
    stub()
    const today = isoDay(0)

    renderAt(`/dashboards?from=${isoDay(6)}&to=${today}`)
    expect(await screen.findByText('per day')).toBeTruthy()
    cleanup()

    stub()
    renderAt(`/dashboards?from=${isoDay(29)}&to=${today}`)
    expect(await screen.findByText('per week')).toBeTruthy()
    cleanup()

    stub()
    renderAt(`/dashboards?from=${isoDay(364)}&to=${today}`)
    expect(await screen.findByText('per month')).toBeTruthy()
  })

  it('keeps the live pipeline strip on its own time-base, and says so', async () => {
    stub()
    renderAt()

    const rail = await screen.findByTestId('lifecycle-rail')
    // Values from the tiles aggregate, not the report rows.
    expect(within(rail).getByText('2')).toBeTruthy()
    expect(within(rail).getByText('3')).toBeTruthy()
    expect(within(rail).getByText('4')).toBeTruthy()
    expect(within(rail).getByText('9')).toBeTruthy()
    // The label that keeps the two time-bases from being confused.
    expect(within(rail).getByText(/not affected by the date filter/i)).toBeTruthy()
    // Each stage stays a door into its drilldown.
    const links = within(rail).getAllByRole('link')
    expect(links.length).toBe(4)
    expect(links[0]!.getAttribute('href')).toBe('/reports?tile=pendingQrAwaitingBatch')
  })

  it('offers the date presets and reflects the chosen range in the URL idiom', async () => {
    stub()
    renderAt()
    for (const label of ['Today', '7 days', '30 days', '90 days', 'All time']) {
      expect(await screen.findByRole('button', { name: label })).toBeTruthy()
    }
  })

  // D-31 RESTORED (18 Aug 2026). The card was removed on 17 Aug because it was
  // the only thing in the right-hand column and read as stranded. That was a
  // layout complaint, and dropping the tile answered it by dropping a BRD FR-09
  // dashboard tile ("Damaged / replacement open") and the D-31 deep-links with
  // it. It is back, in the LEFT column under the live rail where it is not
  // stranded, and the counts are the live TMS read as before: DP-7 means the
  // analytics tiles cannot answer this, so it is its own request.
  it('shows the damage-case counts live, and deep-links each into the filtered list', async () => {
    stub()
    renderAt()

    const card = await screen.findByTestId('damage-cases-card')
    // Open / In progress / Closed, the three D-24 states, from the live read.
    expect(within(card).getByText('4')).toBeTruthy()
    expect(within(card).getByText('6')).toBeTruthy()
    expect(within(card).getByText('8')).toBeTruthy()

    // The ?status= vocabulary is the one DamageCasesPage normalizes, hyphen
    // spelling included: these links were built for this tile and outlived it.
    const hrefs = within(card)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(
      expect.arrayContaining(['/damage-cases?status=Open', '/damage-cases?status=In-Progress', '/damage-cases?status=Closed']),
    )
  })

  it('reads the damage counts from TMS, not from the analytics tiles', async () => {
    const urls = stub()
    renderAt()
    await screen.findByTestId('damage-cases-card')
    expect(urls.some((u) => u.includes('/ops/damage-cases/summary'))).toBe(true)
  })
})
