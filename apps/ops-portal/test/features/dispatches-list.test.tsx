import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchesPage } from '../../src/features/dispatches/DispatchesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The dispatch list, redesigned onto the Inventory pattern: a summary row that IS
// the filter, filters in a toolbar above the grid rather than buried in the card,
// and rows that open the dispatch they name.

const ROWS = [
  { dispatchId: 'asgn_transit', merchantDisplay: 'ALPHA STORE', bankCode: '3', awb: 'AWB1', shptId: 'shpt_1', courierStatus: 'IN_TRANSIT' },
  { dispatchId: 'asgn_delivered', merchantDisplay: 'BETA TRADERS', bankCode: '3', awb: 'AWB2', shptId: 'shpt_2', courierStatus: 'DELIVERED' },
  { dispatchId: 'asgn_returned', merchantDisplay: 'GAMMA GOODS', bankCode: '3', awb: 'AWB3', shptId: 'shpt_3', courierStatus: 'RETURNED' },
  { dispatchId: 'asgn_waiting', merchantDisplay: 'DELTA DEPOT', bankCode: '3', awb: null, shptId: null, courierStatus: null },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push({ url })
      if (url.includes('/ops/dispatches')) return jsonResponse([])
      if (url.includes('/ops/bank-masters')) return jsonResponse([{ tnntId: 't', bankReferenceCode: '3', displayName: 'GSCB', status: 'ACTIVE' }])
      return jsonResponse({ rows: ROWS, watermark: { asOf: null, perTopic: {} } })
    }),
  )
  return calls
}

/** A tile, by the hint that only it carries. */
function tile(hint: string): HTMLButtonElement {
  return screen.getByText(hint).closest('button') as HTMLButtonElement
}

/** The toolbar's own search box, not the shipments grid's. */
function searchBox(): HTMLElement {
  return screen.getByPlaceholderText(/dispatch id, merchant or awb/i)
}

/** Mounted with the real detail route so a row click can be observed landing. */
function renderList() {
  return render(
    <MemoryRouter initialEntries={['/dispatches']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dispatches" element={<DispatchesPage />} />
          <Route path="/dispatches/:asgnId" element={<h1>dispatch page</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('The dispatch list: tiles, toolbar and links', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('summarises the list by the courier ladder, counting only the vocabulary the couriers use', async () => {
    stub()
    renderList()

    // Tiles are found by their HINT, not their label: several tile labels are
    // also column headers, and a test that cannot tell them apart is a test that
    // would pass on the wrong element.
    expect(await screen.findByText('in the current window')).toBeTruthy()
    for (const hint of ['no AWB reported yet', 'picked up, on its way', 'courier confirmed delivery']) {
      expect(screen.getByText(hint)).toBeTruthy()
    }
    // DELTA DEPOT has no AWB, which is exactly what "awaiting vendor" means.
    expect(tile('no AWB reported yet').textContent).toContain('1')
  })

  it('a tile narrows the grid to its own slice, and clicking it again clears it', async () => {
    stub()
    renderList()

    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    const delivered = tile('courier confirmed delivery')

    await userEvent.click(delivered)
    expect(screen.getByText('BETA TRADERS')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()

    await userEvent.click(delivered)
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
  })

  it('searches across the dispatch id, the merchant and the AWB without asking the server again', async () => {
    const calls = stub()
    renderList()
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    const before = calls.length

    await userEvent.type(searchBox(), 'GAMMA')
    expect(screen.getByText('GAMMA GOODS')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
    // The text filter is applied to what was already fetched: a keystroke must
    // not be a round trip.
    expect(calls.length).toBe(before)
  })

  it('clears every filter at once, because clearing them one by one is how a stale filter hides rows', async () => {
    stub()
    renderList()
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()

    await userEvent.type(searchBox(), 'GAMMA')
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }))
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
  })

  it('opens the dispatch page from the row, which is the link the old list never had', async () => {
    stub()
    renderList()

    const row = (await screen.findByText('ALPHA STORE')).closest('tr')!
    await userEvent.click(within(row).getByText('asgn_transit'))
    expect(await screen.findByRole('heading', { name: 'dispatch page' })).toBeTruthy()
  })

  it('renders the bank by the name an operator uses, not the reference code alone', async () => {
    stub()
    renderList()
    // The code is what the report carries; the roster turns it into a name.
    expect(await screen.findAllByText('GSCB')).toBeTruthy()
  })
})
