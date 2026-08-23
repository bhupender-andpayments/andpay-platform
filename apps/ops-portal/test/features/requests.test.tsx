import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { RequestsPage } from '../../src/features/requests/RequestsPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import type { RequestLegRow } from '../../src/api/endpoints.js'

// 23 Aug 2026: the Requests page redesign, giving it the same treatment
// already given to Inventory and Merchants (tiles, filters, fixed-height
// grid). Row shapes are copied from services/tms/src/ops-read.ts
// RequestLegRow, never invented here.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function leg(over: Partial<RequestLegRow> = {}): RequestLegRow {
  return {
    sourceEventId: 'src-1',
    asgnId: 'asgn_soundbox1',
    dispatchGroup: 'SOUNDBOX',
    merchantDisplayName: 'Anand Kirana Stores',
    bankReferenceCode: '3',
    bankDisplayName: 'Gujarat State Co-op Bank',
    branchCode: '30',
    vpaValue: 'anand01@gscb',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    billable: true,
    demandState: 'received',
    caseStatus: null,
    replacementOfAsgnId: null,
    activatedAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    contactName: 'Anand Patel',
    mobile: '9000000001',
    email: 'shop@anand.example',
    shipToAddress: 'SHOP 4 MAIN ROAD',
    city: 'AHMEDABAD',
    state: 'Gujarat',
    pincode: '380001',
    qrType: 'STATIC',
    ...over,
  }
}

// ONE REQUEST, TWO LEGS: the shape the page exists to show.
const ANAND_LEGS: RequestLegRow[] = [
  // Item counts live on the COLLATERAL leg (W-5): the soundbox leg here
  // carries none, so the tile totals below are not double-counted.
  leg({ standeeCount: 0, stickerCount: 0 }),
  leg({ asgnId: 'asgn_collateral1', dispatchGroup: 'COLLATERAL', soundbox: false }),
]

// A second request, different merchant and bank, so filters have something to
// narrow away.
const RAVI_LEGS: RequestLegRow[] = [
  leg({
    sourceEventId: 'src-2',
    asgnId: 'asgn_soundbox2',
    merchantDisplayName: 'Ravi Medical Store',
    bankReferenceCode: '7',
    bankDisplayName: 'HDFC Bank',
    branchCode: '12',
    vpaValue: 'ravi01@hdfc',
    replacementOfAsgnId: 'asgn_original9',
    createdAt: '2026-08-10T10:00:00.000Z',
  }),
]

const ALL_LEGS = [...ANAND_LEGS, ...RAVI_LEGS]

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/requests']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/requests/:sourceEventId" element={<div>REQUEST DETAIL PAGE</div>} />
          <Route path="/dispatches/:asgnId" element={<div>DISPATCH DETAIL PAGE</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('RequestsPage', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  it('lists both requests, grouped one row per source event id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    expect(await screen.findByText('Anand Kirana Stores')).toBeTruthy()
    expect(screen.getByText('Ravi Medical Store')).toBeTruthy()
  })

  it('shows the tiles, counted from the fetched rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    // 2 requests, both asking for a soundbox, 2 standees total (1 + 1), 4
    // stickers total (2 + 2), 2 distinct merchants.
    expect(screen.getByText('Total requests')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Total requests\s*2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Soundbox requests\s*2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Standees requested\s*2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Stickers requested\s*4/ })).toBeTruthy()
    // NO Merchants tile (23 Aug 2026, at the user's correction): every tile is
    // a filter now, one active at a time, and a merchant count has nothing to
    // filter, so a permanently-inert button in that row was the inconsistency.
    expect(screen.queryByRole('button', { name: /Merchants/ })).toBeNull()
  })

  // ONE TILE AT A TIME (23 Aug 2026): the tiles own two params between them
  // (kit and replacement); every click writes its own and clears the other, so
  // two can never light together, exactly like Inventory's row.
  it('keeps exactly one tile active, whichever order they are clicked in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    const pressed = () =>
      screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent ?? '')

    // At rest, Total alone is active.
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]).toMatch(/Total requests/)

    // Soundbox, then Replacements: the second click must clear the first.
    await userEvent.click(screen.getByRole('button', { name: /Soundbox requests/ }))
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]).toMatch(/Soundbox/)

    await userEvent.click(screen.getByRole('button', { name: /Replacement requests/ }))
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]).toMatch(/Replacement requests/)
  })

  it('the Standees and Stickers tiles filter the table like any other', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    // Both fixtures carry standees, so the tile lights and keeps both rows.
    await userEvent.click(screen.getByRole('button', { name: /Standees requested/ }))
    expect(screen.getByRole('button', { name: /Standees requested/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Anand Kirana Stores')).toBeTruthy()

    // Clicking the active tile clears it: a toggle, never a trap.
    await userEvent.click(screen.getByRole('button', { name: /Standees requested/ }))
    expect(screen.getByRole('button', { name: /Total requests/ }).getAttribute('aria-pressed')).toBe('true')
  })

  // THE REPLACEMENT TILE (23 Aug 2026, ops-team ask): damage-driven demand is
  // the number the business watches, so it is a tile and not only a filter.
  it('counts replacement requests in their own tile, and the tile filters to them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    // src-2 is the replacement round (its legs carry replacementOfAsgnId).
    const tile = screen.getByRole('button', { name: /Replacement requests\s*1/ })
    expect(tile).toBeTruthy()

    await userEvent.click(tile)
    expect(await screen.findByText('Ravi Medical Store')).toBeTruthy()
    expect(screen.queryByText('Anand Kirana Stores')).toBeNull()
    // Its own count does NOT collapse to the filtered set: a facet you cannot
    // click back is a trap.
    expect(screen.getByRole('button', { name: /Replacement requests\s*1/ })).toBeTruthy()

    // Clicking again clears it.
    await userEvent.click(screen.getByRole('button', { name: /Replacement requests/ }))
    expect(await screen.findByText('Anand Kirana Stores')).toBeTruthy()
  })

  it('Total requests clears the replacement filter too, so it really shows everything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    await userEvent.click(screen.getByRole('button', { name: /Replacement requests/ }))
    expect(screen.queryByText('Anand Kirana Stores')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Total requests/ }))
    expect(await screen.findByText('Anand Kirana Stores')).toBeTruthy()
    expect(screen.getByText('Ravi Medical Store')).toBeTruthy()
  })

  it('shows the VPA column', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')
    expect(screen.getByText('anand01@gscb')).toBeTruthy()
    expect(screen.getByText('ravi01@hdfc')).toBeTruthy()
  })

  it('narrows the grid with the Bank filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    await userEvent.click(screen.getByLabelText('Bank'))
    await userEvent.click(await screen.findByRole('option', { name: /HDFC Bank/ }))

    expect(screen.getByText('Ravi Medical Store')).toBeTruthy()
    expect(screen.queryByText('Anand Kirana Stores')).toBeNull()
  })

  // REGRESSION GUARD, same bug class as Merchants (23 Aug 2026): the bank
  // filter must key on bankDisplayName, never on bankReferenceCode, which is
  // the bank FILE's own aggregator code and not the Bank Master's.
  it('never shows a real bank at a count of zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    await userEvent.click(screen.getByLabelText('Bank'))
    const option = await screen.findByRole('option', { name: /HDFC Bank/ })
    expect(option.textContent).not.toMatch(/\b0\b/)
  })

  it('narrows the grid with the Replacement filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    await userEvent.click(screen.getByLabelText('Replacement'))
    await userEvent.click(await screen.findByRole('option', { name: /Replacement only/ }))

    expect(screen.getByText('Ravi Medical Store')).toBeTruthy()
    expect(screen.queryByText('Anand Kirana Stores')).toBeNull()
  })

  it('narrows the grid with the Kit filter, and the Soundbox tile drives the same filter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          ...ANAND_LEGS,
          leg({
            sourceEventId: 'src-3',
            asgnId: 'asgn_soundbox3',
            merchantDisplayName: 'Sticker Only Shop',
            soundbox: false,
            standeeCount: 0,
            stickerCount: 5,
          }),
        ]),
      ),
    )
    renderPage()
    await screen.findByText('Anand Kirana Stores')
    expect(screen.getByText('Sticker Only Shop')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /Soundbox requests/ }))
    expect(screen.getByText('Anand Kirana Stores')).toBeTruthy()
    expect(screen.queryByText('Sticker Only Shop')).toBeNull()

    // Toggling the same tile again clears the filter.
    await userEvent.click(screen.getByRole('button', { name: /Soundbox requests/ }))
    expect(screen.getByText('Sticker Only Shop')).toBeTruthy()
  })

  it('searches merchant, bank, branch and VPA', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    await userEvent.type(screen.getByLabelText('Search'), 'hdfc')
    expect(screen.getByText('Ravi Medical Store')).toBeTruthy()
    expect(screen.queryByText('Anand Kirana Stores')).toBeNull()
  })

  it('shows Clear filters only once a filter is active, and clears every param', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')
    expect(screen.queryByRole('button', { name: /clear filters/i })).toBeNull()

    await userEvent.type(screen.getByLabelText('Search'), 'hdfc')
    await userEvent.click(await screen.findByRole('button', { name: /clear filters/i }))

    expect(screen.getByText('Anand Kirana Stores')).toBeTruthy()
    expect(screen.getByText('Ravi Medical Store')).toBeTruthy()
  })

  it('opens the request detail page on a row click, without navigating on a leg badge click', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    // The leg badge inside the row stops propagation: clicking it must jump
    // straight to the dispatch, not open the request detail page.
    await userEvent.click(screen.getAllByRole('button', { name: /^soundbox$/i })[0]!)
    expect(await screen.findByText('DISPATCH DETAIL PAGE')).toBeTruthy()
  })

  it('opens the request detail page when the row itself is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')

    await userEvent.click(screen.getByText('Anand Kirana Stores'))
    expect(await screen.findByText('REQUEST DETAIL PAGE')).toBeTruthy()
  })

  it('has Sample file and Upload bank file actions in the header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(ALL_LEGS)))
    renderPage()
    await screen.findByText('Anand Kirana Stores')
    expect(screen.getByRole('button', { name: /sample file/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /upload bank file/i })).toBeTruthy()
  })
})
