import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DamageCasesPage } from '../../src/features/damage/DamageCasesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// D-24 (T6.6): the damage cases screen. The read has existed at the edge since
// FR08-2 with no portal surface at all, which is most of why those statuses were
// stale: nobody could see them.
//
// D-26/D-31 (damage workflow, B7) add the summary chips (one per case status,
// each a filter synced to ?status= so the dashboard tile can deep-link) and
// the by-VPA dispatch search, which is how a phone call becomes a flag.

interface Call {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const CASES = [
  {
    asgnId: 'asgn_repl1',
    replacementOf: 'asgn_orig1',
    merchantDisplayName: 'Flow Alpha Store',
    bankReferenceCode: 'HDFC',
    branchCode: 'BR-1',
    damageReason: 'battery issue',
    bankRemarks: 'device dead on arrival',
    opsRemarks: null,
    caseStatus: 'Open',
    billable: false,
    demandState: 'pooled-for-fulfillment',
    createdAt: '2026-08-12T09:00:00.000Z',
    updatedAt: '2026-08-12T09:00:00.000Z',
  },
]

const CLOSED_CASE = {
  ...CASES[0],
  asgnId: 'asgn_repl2',
  replacementOf: 'asgn_orig2',
  merchantDisplayName: 'Beta Kirana',
  caseStatus: 'Closed',
}

const SUMMARY = { open: 3, inProgress: 1, closed: 2 }

const VPA_ROW = {
  asgnId: 'asgn_v1',
  dispatchGroup: 'SOUNDBOX',
  bankReferenceCode: 'HDFC',
  bankDisplayName: 'HDFC Bank',
  merchantDisplayName: 'Acme Traders',
  soundbox: true,
  standeeCount: 2,
  stickerCount: 0,
  billable: false,
  replacementOfAsgnId: 'asgn_orig9',
  caseStatus: 'Open',
  demandState: 'pooled-for-fulfillment',
  activationStatus: null,
  activatedAt: null,
  createdAt: '2026-08-12T09:00:00.000Z',
}

function stub(cases: unknown = CASES, vpaRows: unknown[] = [VPA_ROW]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      // ORDER MATTERS: /ops/damage-cases/summary contains /ops/damage-cases.
      if (url.includes('/ops/damage-cases/summary')) return jsonResponse(SUMMARY)
      if (url.includes('/ops/dispatches/by-vpa')) return jsonResponse({ rows: vpaRows })
      if (url.includes('/ops/records/')) return jsonResponse({ deduped: false })
      return jsonResponse(cases)
    }),
  )
  return calls
}

function renderPage(initialEntry = '/damage-cases') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/damage-cases" element={<DamageCasesPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('DamageCasesPage (D-24, T6.6)', () => {
  beforeEach(() => {
    clearAccessToken()
    setAccessToken('tok-1')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
  })

  // FOUR TILES, OPEN BY DEFAULT (24 Aug 2026, at the user's direction). A bare
  // /damage-cases used to land on "everything, closed included" with no chip
  // lit, so the operator could not tell what they were looking at.
  it('lands on Open with its tile lit, and All is one click away', async () => {
    stub([...CASES, CLOSED_CASE])
    renderPage()

    await screen.findByText('Flow Alpha Store')
    // Open is the default: the closed case is out of the table.
    expect(screen.queryByText('Beta Kirana')).toBeNull()
    const openTile = screen.getByText('raised, nobody working it yet').closest('button')!
    expect(openTile.getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(screen.getByText('every damage case ever raised').closest('button')!)
    expect(await screen.findByText('Beta Kirana')).toBeTruthy()
    expect(screen.getByText('Flow Alpha Store')).toBeTruthy()
  })

  it('reads every case once and narrows client-side, so a tile never needs a refetch', async () => {
    const calls = stub([...CASES, CLOSED_CASE])
    renderPage()
    await screen.findByText('Flow Alpha Store')

    // One read, and it asks for the closed rows too: every tile is a narrowing
    // of the same set, so Closed must already be in hand.
    expect(calls.filter((c) => c.url.includes('/ops/damage-cases') && !c.url.includes('summary'))).toHaveLength(1)
    expect(calls.some((c) => c.url.includes('includeClosed=true'))).toBe(true)

    await userEvent.click(screen.getByText('the replacement reached the merchant').closest('button')!)
    expect(await screen.findByText('Beta Kirana')).toBeTruthy()
    expect(calls.filter((c) => c.url.includes('/ops/damage-cases') && !c.url.includes('summary'))).toHaveLength(1)
  })

  // CANCELLED GETS ITS OWN TILE (24 Aug 2026, at the user's direction). It is a
  // real case status the withdraw path writes, and without a tile a withdrawn
  // case was only findable under All.
  it('counts cancelled cases in their own tile and filters to them', async () => {
    const cancelled = { ...CASES[0], asgnId: 'asgn_repl3', merchantDisplayName: 'Gamma Stores', caseStatus: 'Cancelled' }
    stub([...CASES, cancelled])
    renderPage()
    await screen.findByText('Flow Alpha Store')

    const tile = screen.getByText('the request was withdrawn').closest('button')!
    expect(tile.textContent).toContain('1')
    // Not in Open, which is where the page lands.
    expect(screen.queryByText('Gamma Stores')).toBeNull()

    await userEvent.click(tile)
    expect(await screen.findByText('Gamma Stores')).toBeTruthy()
    expect(screen.queryByText('Flow Alpha Store')).toBeNull()
    expect(screen.getByText('Cancelled cases')).toBeTruthy()
  })

  // EVERY FORWARD TRANSITION IS AUTOMATIC (24 Aug 2026, at the user's
  // direction): a case opens on the flag, goes In-Progress when its
  // replacement is batched, and closes when that replacement activates or is
  // delivered. Offering "Move to X" invited an operator to contradict the
  // automation by hand, and the next fact would overrule them anyway.
  it('offers no status moves at all: the menu is View lifecycle and Cancel', async () => {
    stub()
    renderPage()
    await screen.findByText('Flow Alpha Store')

    await userEvent.click(screen.getByRole('button', { name: /actions for flow alpha store/i }))
    expect(await screen.findByRole('menuitem', { name: /view lifecycle/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /cancel this request/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /move to/i })).toBeNull()
  })

  // The SERVER answers 409 "already been batched" for a cancel past Open, so
  // offering it on an In-Progress case promised an action that could only fail.
  it('offers Cancel only while the case is Open', async () => {
    stub([{ ...CASES[0], caseStatus: 'In-Progress' }])
    renderPage('/damage-cases?status=In-Progress')
    await screen.findByText('Flow Alpha Store')

    await userEvent.click(screen.getByRole('button', { name: /actions for flow alpha store/i }))
    expect(await screen.findByRole('menuitem', { name: /view lifecycle/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /cancel this request/i })).toBeNull()
  })

  it('narrows on the search box, across merchant and dispatch id', async () => {
    stub([...CASES, CLOSED_CASE])
    renderPage('/damage-cases?status=all')
    await screen.findByText('Flow Alpha Store')

    await userEvent.type(screen.getByLabelText(/search/i), 'Beta')
    await waitFor(() => {
      expect(screen.queryByText('Flow Alpha Store')).toBeNull()
    })
    expect(screen.getByText('Beta Kirana')).toBeTruthy()
  })

  // ONE BOX, TWO JOBS: a UPI ID (it has an @) also offers the dispatch lookup,
  // which is the phone-call path where no case exists yet.
  it('offers the UPI lookup only once the search looks like a UPI ID', async () => {
    stub()
    renderPage()
    await screen.findByText('Flow Alpha Store')
    expect(screen.queryByRole('button', { name: /find dispatches by upi/i })).toBeNull()

    await userEvent.type(screen.getByLabelText(/search/i), 'shop@hdfc')
    const btn = await screen.findByRole('button', { name: /find dispatches by upi/i })
    await userEvent.click(btn)

    expect(await screen.findByText('Dispatches carrying that UPI ID')).toBeTruthy()
    expect(screen.getByText('Non-billable')).toBeTruthy()
  })

  it('labels the two sets of remarks, because they are different people words', async () => {
    stub([{ ...CASES[0], opsRemarks: 'chased the bank twice' }])
    renderPage()

    const row = (await screen.findByText('Flow Alpha Store')).closest('tr')!
    // Merged into one cell they would read as a single account of the damage.
    expect(within(row).getByText(/bank:/i)).toBeTruthy()
    expect(within(row).getByText(/device dead on arrival/i)).toBeTruthy()
    expect(within(row).getByText(/ops:/i)).toBeTruthy()
    expect(within(row).getByText(/chased the bank twice/i)).toBeTruthy()
  })

  it('links BOTH dispatches, because the replacement and the original are separate journeys', async () => {
    stub()
    renderPage()
    const row = (await screen.findByText('Flow Alpha Store')).closest('tr')!
    const hrefs = within(row)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('/dispatches/asgn_repl1')
    expect(hrefs).toContain('/dispatches/asgn_orig1')
  })

  it('survives a failed read instead of taking the page down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope' }, 500)))
    renderPage()
    expect(await screen.findByText(/could not read the damage cases/i)).toBeTruthy()
  })

  // ---- D-31: the summary chips and the ?status= deep link ------------ //

  it('deep-links: ?status=Closed lands filtered, so the dashboard tile can point at its own rows', async () => {
    stub([CASES[0], CLOSED_CASE])
    renderPage('/damage-cases?status=Closed')

    expect(await screen.findByText('Beta Kirana')).toBeTruthy()
    expect(screen.queryByText('Flow Alpha Store')).toBeNull()
    // The active TILE reads as pressed, and the card names the filter. Its
    // count comes from the loaded rows, not the summary read.
    expect(
      screen.getByText('the replacement reached the merchant').closest('button')!.getAttribute('aria-pressed'),
    ).toBe('true')
    expect(screen.getByText('Closed cases')).toBeTruthy()
  })

  it('accepts the hyphenless spelling too: ?status=In Progress filters the same rows', async () => {
    stub([{ ...CASES[0], caseStatus: 'In-Progress' }])
    renderPage('/damage-cases?status=In%20Progress')
    // The column stores 'In-Progress'; the walkthrough writes 'In Progress'.
    // Both spell the same state, so the filter must match across them.
    expect(await screen.findByText('Flow Alpha Store')).toBeTruthy()
  })

  // ---- D-26: find dispatches by VPA ---------------------------------- //

  it('an empty VPA result says so honestly instead of rendering a blank grid', async () => {
    stub(CASES, [])
    renderPage()
    await screen.findByText('Flow Alpha Store')

    await userEvent.type(screen.getByLabelText(/search/i), 'nobody@nowhere')
    await userEvent.click(await screen.findByRole('button', { name: /find dispatches by upi/i }))

    expect(await screen.findByText(/no dispatches carry that upi id/i)).toBeTruthy()
  })
})
