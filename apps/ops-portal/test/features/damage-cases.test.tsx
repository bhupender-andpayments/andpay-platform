import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DamageCasesPage } from '../../src/features/damage/DamageCasesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// D-24 (T6.6): the damage cases screen. The read has existed at the edge since
// FR08-2 with no portal surface at all, which is most of why those statuses were
// stale: nobody could see them.

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

function stub(cases: unknown = CASES): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.includes('/ops/records/')) return jsonResponse({ deduped: false })
      return jsonResponse(cases)
    }),
  )
  return calls
}

function renderPage() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <DamageCasesPage />
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

  it('offers only the statuses the case is NOT already in', async () => {
    stub()
    renderPage()
    const row = (await screen.findByText('Flow Alpha Store')).closest('tr')!
    // The case is Open, so Open is not offered as somewhere to move it.
    expect(within(row).queryByRole('button', { name: /^open$/i })).toBeNull()
    expect(within(row).getByRole('button', { name: /^in progress$/i })).toBeTruthy()
    expect(within(row).getByRole('button', { name: /^closed$/i })).toBeTruthy()
  })

  it('sends the operator note with the transition, in the walkthrough spelling', async () => {
    const calls = stub()
    renderPage()

    const row = (await screen.findByText('Flow Alpha Store')).closest('tr')!
    await userEvent.type(within(row).getByLabelText(/note for flow alpha store/i), 'awaiting bank reply')
    await userEvent.click(within(row).getByRole('button', { name: /^in progress$/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/records/asgn_repl1/damage-case-status'))).toBe(true)
    })
    const write = calls.find((c) => c.url.includes('/ops/records/'))!
    const body = JSON.parse(String(write.init.body)) as { status: string; opsRemarks?: string }
    // "In Progress" is the walkthrough's spelling; the column stores
    // "In-Progress" and the server normalizes, so the portal sends what an
    // operator read on the button.
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
})
