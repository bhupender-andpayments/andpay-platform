import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { AppRoutes } from '../../src/routes.js'
import { clearAccessToken } from '../../src/api/tokenStore.js'

// Phase 7 Task 13a consistency smoke test: mount the real authenticated shell
// (routes.tsx -> AppShell, Task 1/3/13a) and route through every one of the 11
// live sidebar sections (AppShell's own SECTIONS, now including Activation, the
// redesign step-7 Merchants, and the 2026-08-11 Workflow workspace),
// asserting each section's own heading renders and nothing throws or logs a
// console.error along the way. This is the final proof that the sidebar,
// routing, and each feature page's default (mount-time) data fetch are all
// wired together consistently, not a per-feature functional test (those
// already exist under test/features/*).

function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const TILES_FIXTURE = {
  requestsReceived: 0,
  totalBatches: 4,
  pendingQrAwaitingBatch: { count: 0, oldestAgeDays: null },
  pendingPrintVendorPickup: 0,
  dispatchedNotDelivered: 0,
  // D-16 (T4.2): real numbers, which is what TileSet always declared. These two
  // carried `null` while the page refused to render them, so the fixture drifted
  // from the wire contract unnoticed; the moment the tiles started reading their
  // values, a null took the whole dashboard down.
  deliveredNotActivated: 0,
  damagedReplacementOpen: 0,
  activatedSuccessfully: 0,
}

// A single fetch stub that answers every mount-time read the 12 sections'
// DEFAULT tab issues (dashboards tiles, the reports page's default report,
// queues' default quarantine tab, master-data's default vendor-registry tab,
// the activation worklist report), plus login/rehydrate.
//
// The workflow workspace fetches on mount too (the pool, the batch list, the
// batching config, and the Needs-you counts) and every one of those falls
// through to the empty-array default below, which is exactly what that default
// is for. /uploads no longer needs a branch because it renders an index of
// cards and issues no mount-time read at all: the bank flow that used to live
// there is now stages 1 and 2 of the workspace.
function stubPortalFetch(fakeToken: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/session/rehydrate')) return new Response(null, { status: 401 })
      if (url.includes('/session/login')) {
        return jsonResponse({ accessToken: fakeToken })
      }
      if (url.includes('/ops/reports/tiles')) {
        return jsonResponse({ tiles: TILES_FIXTURE, watermark: { asOf: '2026-08-06T00:00:00.000Z', perTopic: {} } })
      }
      if (url.includes('/ops/reports/activation')) {
        return jsonResponse({ rows: [], watermark: { asOf: '2026-08-06T00:00:00.000Z', perTopic: {} } })
      }
      if (url.includes('/ops/reports/soundbox-delivery')) {
        return jsonResponse({ rows: [], watermark: { asOf: '2026-08-06T00:00:00.000Z', perTopic: {} } })
      }
      if (url.includes('/ops/quarantine')) return jsonResponse([])
      if (url.includes('/ops/vendors')) return jsonResponse([])
      // Any other read this test does not exercise (e.g. a section's
      // non-default tab) still gets a harmless empty-array response rather
      // than an unhandled rejection, so an unrelated future fetch never
      // turns this smoke test red for the wrong reason.
      return jsonResponse([])
    }),
  )
}

function AuthedAppRoutes({ onError }: { onError(err: unknown): void }) {
  const { login, principal } = useAuth()
  useEffect(() => {
    if (principal === null) {
      login({ handle: 'alice', password: 'pw', totp: '123456' }).catch(onError)
    }
  }, [login, principal, onError])
  if (principal === null) return null
  return <AppRoutes />
}

async function renderAuthedShell(): Promise<void> {
  const fakeToken = makeFakeJwt({ sub: 'ops-1', psr: 'role:ops' })
  stubPortalFetch(fakeToken)
  render(
    <MemoryRouter initialEntries={['/command-center']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <AuthedAppRoutes onError={(e) => { throw e }} />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('navigation', { name: /main/i })
}

// The 11 live sidebar sections in AppShell's own order (src/ui/AppShell.tsx),
// each paired with the exact heading its page renders (PageHeader's title
// prop, confirmed by reading every feature page: WorkflowPage/TilesPage/
// ReportPage/QueuesPage/MasterDataPage/UploadsPage/OperationsPage/
// ActivationPage/MerchantsPage).
const SECTIONS: ReadonlyArray<{ label: string; heading: RegExp }> = [
  { label: 'Command Center', heading: /^command center$/i },
  { label: 'Merchants', heading: /^merchants$/i },
  { label: 'Reports', heading: /^reports$/i },
  { label: 'Queues', heading: /^queues$/i },
  { label: 'Master Data', heading: /^master data$/i },
  { label: 'Uploads', heading: /^uploads$/i },
  { label: 'Batches', heading: /^batches$/i },
  { label: 'Dispatches', heading: /^dispatches$/i },
  { label: 'Inventory', heading: /^inventory$/i },
  { label: 'Activation', heading: /^activation$/i },
  // D-24 (T6.6): the damage cases screen.
  { label: 'Damage cases', heading: /^damage cases$/i },
]

describe('ops-portal consistency smoke test (Phase 7 Task 13a)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearAccessToken()
    vi.unstubAllGlobals()
    // Explicit spy (not a global fail-on-console-error hook): vitest.config.ts
    // sets no such hook, so this test asserts it directly, same discipline as
    // the rest of the suite's explicit `cleanup()` calls below.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    consoleErrorSpy.mockRestore()
  })

  it('mounts the shell authenticated and routes through all 11 sections with no thrown errors and no console.error', async () => {
    await renderAuthedShell()

    const nav = screen.getByRole('navigation', { name: /main/i })
    // Sanity check this test's own section table is not stale against the
    // real live sidebar before routing through it.
    // Compared as a SET: the sidebar groups these links under section headings,
    // so document order is presentation, while "this table matches the real
    // sidebar" is what the sanity check is for. Every section is still visited
    // individually below.
    const linkNames = within(nav).getAllByRole('link').map((l) => l.textContent?.trim())
    expect([...linkNames].sort()).toEqual([...SECTIONS.map((s) => s.label)].sort())

    for (const section of SECTIONS) {
      const link = within(nav).getByRole('link', { name: new RegExp(`^${section.label}$`, 'i') })
      await userEvent.click(link)
      expect(await screen.findByRole('heading', { name: section.heading })).toBeTruthy()
    }

    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})
