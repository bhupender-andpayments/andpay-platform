import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ReportPage } from '../../src/features/dashboards/ReportPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Redesign step 5. Two separate ways this screen asked the operator to know
// something they have no way to know.
//
// 1. A "View" dropdown offering "Report" or "Tile drilldown". That is OUR
//    distinction, not theirs: 6 named reports and 7 tile drilldowns are 13
//    datasets, and the operator had to pick a KIND before picking the thing.
//    A drilldown is still reachable, through ?tile= set by Command Center,
//    where the operator clicks a number and lands on its rows. They never
//    choose the mode, because there is no reason they should know it exists.
//
// 2. Bank and Status were free-text boxes with placeholders like "e.g. HDFC"
//    and "e.g. DELIVERED". That is the typed-id problem again: type the exact
//    string or silently get nothing back. A filter over a KNOWN value set is a
//    picker.

const BANKS = [
  { tnntId: 'tnnt_1', bankReferenceCode: '3', displayName: 'GSCB', status: 'ACTIVE' },
  { tnntId: 'tnnt_2', bankReferenceCode: '18', displayName: 'Rajkot Nagarik', status: 'ACTIVE' },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url })
    if (url.includes('/ops/bank-masters')) return jsonResponse(BANKS)
    return jsonResponse({ rows: [], watermark: { asOf: null, perTopic: {} } })
  }))
  return calls
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ReportPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('Reports: the operator never picks a "kind"', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('shows no View / mode control at all', () => {
    stub()
    renderAt('/reports')
    expect(screen.queryByLabelText(/^view$/i)).toBeNull()
    expect(screen.queryByText(/tile drilldown/i)).toBeNull()
  })

  it('still lists every named report to choose from', () => {
    stub()
    renderAt('/reports')
    expect(screen.getByLabelText(/report/i)).toBeTruthy()
  })

  // The drilldown path survives, it is just never a choice the operator makes.
  it('still loads a tile drilldown when Command Center links in with ?tile=', async () => {
    const calls = stub()
    renderAt('/reports?tile=deliveredNotActivated')
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('/ops/reports/tiles/deliveredNotActivated'))).toBe(true)
    })
  })
})

describe('Reports: filters over a known value set are pickers, not free text', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('offers the real banks rather than asking the operator to type one', async () => {
    stub()
    renderAt('/reports')
    const bank = await screen.findByLabelText(/bank/i)
    expect(bank.tagName).toBe('SELECT')
    expect(await screen.findByRole('option', { name: 'GSCB' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Rajkot Nagarik' })).toBeTruthy()
  })

  it('offers the real courier statuses rather than asking the operator to type one', async () => {
    stub()
    renderAt('/reports')
    const status = await screen.findByLabelText(/status/i)
    expect(status.tagName).toBe('SELECT')
    expect(screen.getByRole('option', { name: 'DELIVERED' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'OUT_FOR_DELIVERY' })).toBeTruthy()
  })

  it('sends the picked bank code, not its display name, to the edge', async () => {
    const calls = stub()
    renderAt('/reports')
    await userEvent.selectOptions(await screen.findByLabelText(/bank/i), '3')
    await userEvent.click(screen.getByRole('button', { name: /search/i }))
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes('bank=3'))).toBe(true)
    })
  })

  it('keeps an "any" choice so a filter can be cleared', async () => {
    stub()
    renderAt('/reports')
    const bank = await screen.findByLabelText(/bank/i)
    expect(bank.querySelector('option[value=""]')).toBeTruthy()
  })
})
