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
  return {
    id,
    status: 'BORN',
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
