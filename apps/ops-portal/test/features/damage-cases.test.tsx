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

  it('hides closed cases by default, and asks the SERVER for them rather than filtering a partial list', async () => {
    const calls = stub()
    renderPage()

    await screen.findByText('Flow Alpha Store')
    expect(calls.some((c) => c.url.includes('includeClosed=true'))).toBe(false)

    await userEvent.selectOptions(screen.getByLabelText(/show/i), 'all')
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('includeClosed=true'))).toBe(true)
    })
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

  // THE MOVES LIVE IN A KEBAB (18 Aug 2026). They used to be buttons sitting
  // permanently in every row, which put an irreversible-feeling status change
  // one stray click away and made the row a wall of controls.
  async function openActions(rowText: string): Promise<void> {
    const row = (await screen.findByText(rowText)).closest('tr')!
    await userEvent.click(within(row).getByRole('button', { name: /^actions for/i }))
  }

  it('offers only the statuses the case is NOT already in', async () => {
    stub()
    renderPage()
    await openActions('Flow Alpha Store')
    // The case is Open, so Open is not offered as somewhere to move it.
    expect(screen.queryByRole('menuitem', { name: /move to open/i })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /move to in progress/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /move to closed/i })).toBeTruthy()
  })

  // The regression this menu was built on top of: the column stores
  // 'In-Progress' and the option list carried 'In Progress', so a `!==`
  // comparison never matched and an in-progress case was offered "In Progress"
  // as somewhere to move to. Every comparison goes through statusKey now.
  it('does not offer In progress to a case that is ALREADY in progress', async () => {
    stub([{ ...CASES[0], caseStatus: 'In-Progress' }])
    renderPage()
    await openActions('Flow Alpha Store')
    expect(screen.queryByRole('menuitem', { name: /move to in progress/i })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /move to open/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /move to closed/i })).toBeTruthy()
  })

  it('confirms before moving, and does not write while the dialog is merely open', async () => {
    const calls = stub()
    renderPage()
    await openActions('Flow Alpha Store')
    await userEvent.click(screen.getByRole('menuitem', { name: /move to closed/i }))

    expect(await screen.findByText(/move this case to closed\?/i)).toBeTruthy()
    expect(calls.some((c) => c.url.includes('/damage-case-status'))).toBe(false)
  })

  it('warns that a BACKWARD move can be undone by the automation', async () => {
    stub([{ ...CASES[0], caseStatus: 'Closed' }])
    renderPage()
    await openActions('Flow Alpha Store')
    await userEvent.click(screen.getByRole('menuitem', { name: /move to open/i }))
    expect(await screen.findByText(/moves the case backwards/i)).toBeTruthy()
  })

  it('sends the operator note with the transition, in the walkthrough spelling', async () => {
    const calls = stub()
    renderPage()

    await openActions('Flow Alpha Store')
    await userEvent.click(screen.getByRole('menuitem', { name: /move to in progress/i }))
    // The note rides with the confirmation now, not with the row.
    await userEvent.type(await screen.findByLabelText(/^note$/i), 'awaiting bank reply')
    await userEvent.click(screen.getByRole('button', { name: /^move to in progress$/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/records/asgn_repl1/damage-case-status'))).toBe(true)
    })
    const write = calls.find((c) => c.url.includes('/ops/records/'))!
    const body = JSON.parse(String(write.init.body)) as { status: string; opsRemarks?: string }
    // "In Progress" is the walkthrough's spelling; the column stores
    // "In-Progress" and the server normalizes, so the portal sends what an
    // operator read on the menu item.
    expect(body.status).toBe('In Progress')
    expect(body.opsRemarks).toBe('awaiting bank reply')
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

  it('renders the three summary counts as chips, and clicking one filters the grid by that status', async () => {
    const calls = stub([CASES[0], CLOSED_CASE])
    renderPage()

    // Both fixtures on screen before any filter.
    await screen.findByText('Flow Alpha Store')
    await screen.findByText('Beta Kirana')

    // The chips carry the summary read's counts, not a client-side count of
    // the (possibly closed-excluded) grid.
    const openChip = await screen.findByRole('button', { name: /open\s*3/i })
    expect(screen.getByRole('button', { name: /in progress\s*1/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /closed\s*2/i })).toBeTruthy()

    await userEvent.click(openChip)
    // A filtered read always asks the server for everything (Closed is one of
    // the filters), then narrows to the chip's status.
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('includeClosed=true'))).toBe(true)
    })
    expect(await screen.findByText('Flow Alpha Store')).toBeTruthy()
    expect(screen.queryByText('Beta Kirana')).toBeNull()
  })

  it('deep-links: ?status=Closed lands filtered, so the dashboard tile can point at its own rows', async () => {
    stub([CASES[0], CLOSED_CASE])
    renderPage('/damage-cases?status=Closed')

    expect(await screen.findByText('Beta Kirana')).toBeTruthy()
    expect(screen.queryByText('Flow Alpha Store')).toBeNull()
    // The active chip reads as pressed, and the card names the filter.
    expect((await screen.findByRole('button', { name: /closed\s*2/i })).getAttribute('aria-pressed')).toBe('true')
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

  it('VPA search runs on SUBMIT, not per keystroke, and renders the dispatches with a link and the billing pill', async () => {
    const calls = stub()
    renderPage()
    await screen.findByText('Flow Alpha Store')

    await userEvent.type(screen.getByLabelText(/upi id/i), 'acme@hdfcbank')
    // Nothing fires while typing.
    expect(calls.some((c) => c.url.includes('/ops/dispatches/by-vpa'))).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/dispatches/by-vpa?vpa=acme%40hdfcbank'))).toBe(true)
    })

    // The row: dispatch id as a link into the page that owns the flag, the
    // group chip, and D-28's billing answer in words.
    const link = await screen.findByRole('link', { name: /asgn_v1/ })
    expect(link.getAttribute('href')).toBe('/dispatches/asgn_v1')
    expect(screen.getByText('Acme Traders')).toBeTruthy()
    expect(screen.getByText('Non-billable')).toBeTruthy()
    expect(screen.getByLabelText('Soundbox dispatch')).toBeTruthy()
  })

  it('an empty VPA result says so honestly instead of rendering a blank grid', async () => {
    stub(CASES, [])
    renderPage()
    await screen.findByText('Flow Alpha Store')

    await userEvent.type(screen.getByLabelText(/upi id/i), 'nobody@nowhere')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))

    expect(await screen.findByText(/no dispatches carry that upi id/i)).toBeTruthy()
  })
})
