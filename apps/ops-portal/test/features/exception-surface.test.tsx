import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { ExceptionSurface } from '../../src/features/dashboards/ExceptionSurface.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Redesign step 6. Exceptions used to sit behind a Queues nav item, so an
// operator only found a stuck row if they went looking for one. Nothing on the
// landing page said anything was wrong.
//
// The landing page is now the exception surface: it says what needs attention,
// or says plainly that nothing does.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(opts: { quarantine?: unknown[]; intake?: unknown[]; status?: unknown[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/ops/quarantine')) return jsonResponse(opts.quarantine ?? [])
    if (url.includes('/ops/exceptions/intake')) return jsonResponse(opts.intake ?? [])
    if (url.includes('/ops/exceptions/status')) return jsonResponse(opts.status ?? [])
    return jsonResponse([])
  }))
}

function renderSurface() {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <ExceptionSurface />
      </AuthProvider>
    </MemoryRouter>,
  )
}

const QUARANTINE_ROW = { id: 'q1', fileId: 'gscb.csv', rowNo: 5, reasonCode: 'invalid_mobile_format', resolvedAt: null }
const INTAKE_ROW = { id: 'i1', vndrId: 'vndr_1', fileId: 'cwd.csv', rowRef: 'row-12', reasonCode: 'unknown_device_serial', resolvedAt: null }

describe('ExceptionSurface: the landing page says what needs attention', () => {
  beforeEach(() => { setAccessToken('t'); vi.unstubAllGlobals() })
  afterEach(() => { cleanup(); clearAccessToken() })

  it('counts each kind of exception', async () => {
    stub({ quarantine: [QUARANTINE_ROW, { ...QUARANTINE_ROW, id: 'q2' }], intake: [INTAKE_ROW] })
    renderSurface()
    expect(await screen.findByText(/2 rows/i)).toBeTruthy()
    expect(await screen.findByText(/1 row/i)).toBeTruthy()
  })

  it('names what each queue actually is, not just its table name', async () => {
    stub({ quarantine: [QUARANTINE_ROW] })
    renderSurface()
    expect(await screen.findByText(/rejected bank rows/i)).toBeTruthy()
  })

  // The whole point: a route straight to the work, not just a number.
  it('links to the queue that holds the work', async () => {
    stub({ quarantine: [QUARANTINE_ROW] })
    renderSurface()
    const link = await screen.findByRole('link', { name: /rejected bank rows/i })
    expect(link.getAttribute('href')).toBe('/queues')
  })

  it('says plainly when nothing needs attention', async () => {
    stub()
    renderSurface()
    expect(await screen.findByText(/nothing needs attention/i)).toBeTruthy()
  })

  // A queue with zero rows is NOISE on a page whose job is to show problems.
  it('lists only the queues that actually hold something', async () => {
    stub({ quarantine: [QUARANTINE_ROW] })
    renderSurface()
    expect(await screen.findByText(/rejected bank rows/i)).toBeTruthy()
    expect(screen.queryByText(/device intake/i)).toBeNull()
  })

  // A dashboard that silently shows "nothing needs attention" because the read
  // failed is worse than one that shows an error: it actively reassures.
  it('never reports all-clear when it could not load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('edge down') }))
    renderSurface()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/nothing needs attention/i)).toBeNull()
  })
})
