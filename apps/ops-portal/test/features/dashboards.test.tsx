import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { TilesPage } from '../../src/features/dashboards/TilesPage.js'
import { ReportPage } from '../../src/features/dashboards/ReportPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The confirmed edge contract (apps/ops-edge/src/reports.controller.ts +
// services/analytics/src/mediation.ts): GET /ops/reports/tiles returns
// { tiles: TileSet, watermark }, GET /ops/reports/tiles/:tile and
// GET /ops/reports/:name return { rows, watermark }. D100: the watermark
// rides the JSON body, never a header the client cannot read.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// A dashboard shell that renders TilesPage at /dashboards and ReportPage at
// /reports, mirroring routes.tsx exactly (both routes, no AppShell wrapper,
// since neither page depends on it). Used to prove a tile click drives a real
// drilldown fetch whose rows are consistent with the tile it came from.
function renderDashboardShell(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dashboards" element={<TilesPage />} />
          <Route path="/reports" element={<ReportPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('TilesPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  const TILES_FIXTURE = {
    requestsReceived: 5,
    totalBatches: 12, // distinct from every other fixture value, so a text assertion is unambiguous
    pendingQrAwaitingBatch: { count: 2, oldestAgeDays: 1.5 },
    pendingPrintVendorPickup: 3,
    dispatchedNotDelivered: 4,
    deliveredNotActivated: 9,
    damagedReplacementOpen: 1,
    activatedSuccessfully: 7,
  }

  // D-16 (T4.2): this used to assert that the two activation tiles rendered
  // "Not available yet" instead of their backend values, and that was right
  // while nothing wrote activation_status: one tile equalled the whole delivered
  // set and the other was always zero. Both have real data behind them now, so
  // hiding them would suppress the numbers an operator came here for.
  it('renders every tile from the real analytics aggregate, activation included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          tiles: TILES_FIXTURE,
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <TilesPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const grid = await screen.findByTestId('tile-grid')
    // Every value asserted below comes straight from TILES_FIXTURE above: if
    // the component ever hardcoded a tile value, changing the fixture would
    // stop changing the render, which is exactly what this test guards.
    expect(within(grid).getByText('5')).toBeTruthy()
    expect(within(grid).getByText('2')).toBeTruthy()
    expect(within(grid).getByText('3')).toBeTruthy()
    expect(within(grid).getByText('4')).toBeTruthy()
    expect(within(grid).getByText('1')).toBeTruthy()
    // The two activation tiles now render their real values.
    expect(within(grid).getAllByText('9').length).toBeGreaterThan(0)
    expect(within(grid).getByText('7')).toBeTruthy()
    expect(screen.queryByText(/not available/i)).toBeNull()
    // The watermark badge reflects the body's watermark.asOf, not a header.
    // The badge renders the instant in the reader's locale rather than as a raw
    // ISO string, and keeps the exact instant on the title attribute. Asserting
    // the title is both locale-independent and a tighter check than matching
    // formatted text.
    const badge = screen.getByTitle('2026-07-29T12:00:00.000Z')
    expect(badge.textContent).toMatch(/^as of /)
  })

  it('emphasizes exactly one tile with a filled accent treatment; every other tile stays neutral (E design cue)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          tiles: TILES_FIXTURE,
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        }),
      ),
    )

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <TilesPage />
        </AuthProvider>
      </MemoryRouter>,
    )

    const grid = await screen.findByTestId('tile-grid')
    const links = within(grid).getAllByRole('link')
    // 8 since design D8 added the total-batches tile, which counts BATCHES
    // where the other seven count records.
    expect(links).toHaveLength(8)
    // Exactly ONE anchor tile, still. The mechanism moved with the design system
    // port: section 6.4 has no solid-fill card, so emphasis is the brand amber
    // left border on the same card shape rather than a navy fill.
    const emphasized = links.filter((l) => l.className.includes('border-l-primary'))
    expect(emphasized).toHaveLength(1)
    // and it must not be expressed as a filled tile any more
    expect(links.filter((l) => l.className.includes('bg-brand'))).toHaveLength(0)
  })

  it('a tile click drives the real tile-drilldown fetch, and the rendered drilldown rows are consistent with the tile it came from', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        if (url.includes('/ops/reports/tiles/damagedReplacementOpen')) {
          return jsonResponse({
            rows: [
              { dispatchId: 'asgn_1', bankCode: 'HDFC', replacementStatus: 'RAISED' },
              { dispatchId: 'asgn_2', bankCode: 'ICICI', replacementStatus: 'RAISED' },
            ],
            watermark: { asOf: '2026-07-30T09:00:00.000Z', perTopic: {} },
          })
        }
        return jsonResponse({
          tiles: { ...TILES_FIXTURE, damagedReplacementOpen: 2 },
          watermark: { asOf: '2026-07-29T12:00:00.000Z', perTopic: {} },
        })
      }),
    )

    renderDashboardShell('/dashboards')

    await screen.findByTestId('tile-grid')
    const tileLink = screen.getByRole('link', { name: /damaged, replacement open/i })
    // The tile shows the real count (2) before the click, confirming the
    // drilldown's row count below is not an independent coincidence.
    expect(within(tileLink).getByText('2')).toBeTruthy()

    await userEvent.click(tileLink)

    expect(await screen.findByText('asgn_1')).toBeTruthy()
    expect(screen.getByText('asgn_2')).toBeTruthy()
    expect(screen.getAllByText(/^asgn_\d$/)).toHaveLength(2)
    // 2 rendered drilldown rows === the damagedReplacementOpen tile's own
    // count of 2: the drilldown is a real filtered read, not a fabricated list.
    expect(urls.some((u) => u.includes('/ops/reports/tiles/damagedReplacementOpen'))).toBe(true)
  })
})

// The ReportPage-specific test suite lives in test/features/reports.test.tsx
// (Task 5); ReportPage is still imported/rendered above only as the drilldown
// target inside renderDashboardShell's route table.
