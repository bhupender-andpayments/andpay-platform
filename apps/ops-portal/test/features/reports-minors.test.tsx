import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ReportPage } from '../../src/features/dashboards/ReportPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// G-7, the two deferred minors on this screen that turned out to be real.
//
// 1. NUMERIC ALIGNMENT WAS DRIVEN BY A HARD-CODED KEY LIST. The `num` class
//    (tabular figures, right aligned) was applied by looking the column key up
//    in a static Set. buildColumns directly above it derives columns from what
//    the backend ACTUALLY returned, precisely so this screen never carries an
//    invented column list, and the numeric rule contradicted that. The list
//    happened to be complete on the day it was written; the point is that a
//    numeric column added to any of the 6 reports or 7 drilldowns afterwards
//    would silently render left-aligned and nobody would notice. Same class as
//    the global teardown's runtime table enumeration.
//
// 2. EXPORT FAILED SILENTLY. handleExport had no error handling and was called
//    as `void handleExport()`, so a failed CSV request rejected into nothing:
//    the operator clicked Export CSV, no file arrived, and no message said why.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
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

describe('Reports: numeric cells are detected from the VALUE, not a key list', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  // The key here is deliberately NOT one of the three the old static list knew
  // about, and is the shape a future report column would take.
  it('right-aligns a numeric column the static list never listed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse([])
        return jsonResponse({
          rows: [{ bankCode: 'GSCB', unitsShipped: 42, merchantDisplay: 'Kirana Corner' }],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )
    renderAt('/reports')

    const numeric = await screen.findByText('42')
    expect(numeric.className).toContain('num')
  })

  // A number-LOOKING string must not be right-aligned: bank codes, pincodes and
  // ids are digits that are not quantities, and aligning them as figures reads
  // as arithmetic the column does not support.
  it('does not right-align a numeric-looking STRING', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse([])
        return jsonResponse({
          rows: [{ bankCode: '3', merchantDisplay: 'Kirana Corner' }],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )
    renderAt('/reports')

    const code = await screen.findByText('3')
    expect(code.className ?? '').not.toContain('num')
  })
})

describe('Reports: a failed CSV export tells the operator', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('surfaces the error instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/ops/bank-masters')) return jsonResponse([])
        if (url.includes('format=csv')) {
          return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })
        }
        return jsonResponse({
          rows: [{ bankCode: 'GSCB', merchantDisplay: 'Kirana Corner' }],
          watermark: { asOf: null, perTopic: {} },
        })
      }),
    )
    renderAt('/reports')
    await screen.findByText('Kirana Corner')

    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))

    // Asserted on the ALERT ROLE, not on wording: the message is whatever the
    // API error carries, and pinning its text would make this a test of the
    // error string. What must not happen is nothing at all.
    const alert = await screen.findByRole('alert')
    expect((alert.textContent ?? '').trim().length).toBeGreaterThan(0)
  })
})
