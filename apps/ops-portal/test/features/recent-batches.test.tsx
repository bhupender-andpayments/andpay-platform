import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { RecentBatches } from '../../src/features/dashboards/RecentBatches.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// C-3: the Command Center's below-the-fold region. Row shapes are copied from
// services/fulfillment/src/ops-read.ts BatchRow, never invented.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function batch(id: string, createdAt: string, over: Record<string, unknown> = {}) {
  // NO `status` here, and its absence is the point. This fixture used to supply
  // status: 'BORN', a field the server stopped sending on 2026-08-10 and a value
  // that was the write-once 'BORN' every batch carried for its whole life even
  // when it did exist. So the suite rendered a populated pill while the real app
  // rendered an empty one, and the widget's defect was invisible here. A fixture
  // must answer what the server answers.
  return {
    id,
    triggerReason: 'LOT_SIZE',
    unitCount: 3,
    printVndr: null,
    triggeredByActor: null,
    createdAt,
    updatedAt: createdAt,
    ...over,
  }
}

function renderIt() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <RecentBatches />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('RecentBatches', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('lists batches newest first, whatever order the edge returned', async () => {
    // The widget states the order it wants rather than inheriting one it does
    // not control, so the fixture is deliberately shuffled.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          batch('btch_mid', '2026-08-02T00:00:00.000Z'),
          batch('btch_old', '2026-08-01T00:00:00.000Z'),
          batch('btch_new', '2026-08-03T00:00:00.000Z'),
        ]),
      ),
    )
    renderIt()
    await screen.findByText('btch_new')
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((r) => within(r).getByText(/^btch_/).textContent)).toEqual([
      'btch_new',
      'btch_mid',
      'btch_old',
    ])
  })

  it('shows only the most recent few, because this is an entry point not the list', async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      batch(`btch_${String(i)}`, `2026-08-0${String((i % 9) + 1)}T00:00:00.000Z`),
    )
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(many)))
    renderIt()
    await screen.findByText(/most recent/i)
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('links each row to that batch, so a number finally reaches its object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([batch('btch_x', '2026-08-03T00:00:00.000Z')])))
    renderIt()
    const row = await screen.findByRole('link', { name: /btch_x/ })
    expect(row.getAttribute('href')).toBe('/batches/btch_x')
  })

  it('offers a way to the full list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    renderIt()
    expect((await screen.findByRole('link', { name: /all batches/i })).getAttribute('href')).toBe('/batches')
  })

  it('explains an empty state instead of showing a bare zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])))
    renderIt()
    expect(await screen.findByText(/no batches yet/i)).toBeTruthy()
    expect(screen.getByText(/pooled|wait time/i)).toBeTruthy()
  })

  it('reads the STORED unit count and singularises it', async () => {
    // Nothing here aggregates: the count is the row's stored unit_count, so the
    // no-aggregate rule on ops-read stays untouched.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse([batch('btch_one', '2026-08-03T00:00:00.000Z', { unitCount: 1 })])),
    )
    renderIt()
    expect(await screen.findByText('1 record')).toBeTruthy()
  })

  it('formats the unit count through fmtNumber and renders no status pill', async () => {
    // Two defects in one row, both of which the old fixture hid.
    //
    // The count was rendered bare, so a four-figure batch printed "1234 records".
    // Every count in this portal goes through fmtNumber, and the only way to see
    // the difference is a number with a thousands separator in it: the suite's
    // other counts are 1 and 3, which format identically either way.
    //
    // The pill was bound to b.status, a field the server has not sent since
    // 2026-08-10, so it rendered empty for every row in the real app while this
    // suite showed 'BORN' from its own fixture. Asserting its ABSENCE keeps it
    // from being reintroduced without a read that can answer it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse([batch('btch_big', '2026-08-03T00:00:00.000Z', { unitCount: 1234 })])),
    )
    renderIt()
    const row = await screen.findByRole('listitem')
    expect(within(row).getByText('1,234 records')).toBeTruthy()
    expect(within(row).queryByText('1234 records')).toBeNull()
    expect(within(row).queryByText('BORN')).toBeNull()
  })

  it('distinguishes batches formed on the SAME DAY, so the claimed order is visible', async () => {
    // The widget's only claim is "the most recent". Batches routinely form
    // several times a day, and a date-only stamp rendered all of them
    // identically, so the ordering it asserts could not be checked against the
    // screen asserting it. Deliberately NOT asserting a formatted literal:
    // that would pin a locale and a timezone. Two instants four hours apart on
    // one UTC day must simply render differently, which is true in any fixed
    // zone and false for any date-only format.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          batch('btch_early', '2026-08-03T02:00:00.000Z'),
          batch('btch_later', '2026-08-03T06:00:00.000Z'),
        ]),
      ),
    )
    renderIt()
    await screen.findByText('btch_later')
    const rows = screen.getAllByRole('listitem')
    const stamps = rows.map((r) => within(r).getByText(/\d{2}:\d{2}/).textContent)
    expect(stamps).toHaveLength(2)
    expect(stamps[0]).not.toEqual(stamps[1])
  })

  it('survives a non-array body instead of taking the whole dashboard down', async () => {
    // EntityPicker's .map on a non-array threw during render and killed its
    // entire host page. This widget sits on the Command Center, so the same
    // mistake would blank the page an operator starts their day on.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ unexpected: true })))
    renderIt()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('renders an error note when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 'boom', message: 'nope' }, 500)))
    renderIt()
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
