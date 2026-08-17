import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { AppRoutes } from '../../src/routes.js'
import { AppShell } from '../../src/ui/AppShell.js'
import { clearAccessToken } from '../../src/api/tokenStore.js'

// The pages that fetch on mount are replaced with inert stubs FOR THIS FILE
// ONLY. What is under test here is the ROUTE TABLE and the shell: which path
// resolves to which section, and that the renamed paths still redirect. The
// pages' own behaviour is covered by their own suites.
//
// This is not tidiness, it is a correctness fix. With the real pages mounted,
// an in-flight fetch resolving after the nav first rendered tore the session
// down mid-assertion, emptying the tree. The suite failed 3 runs in 5, and a
// test that fails at random is worse than no test: it trains you to re-run
// instead of to read. Stubbing removes the network from a test that was never
// about the network.
vi.mock('../../src/features/dashboards/TilesPage.js', () => ({
  TilesPage: () => <div>tiles stub</div>,
}))
vi.mock('../../src/features/fulfillment/FulfillmentPage.js', () => ({
  FulfillmentPage: () => <div>batches stub</div>,
}))
vi.mock('../../src/features/fulfillment/generate/BatchGeneratePage.js', () => ({
  BatchGeneratePage: () => <div>batch detail stub</div>,
}))

// Same fake-JWT approach as test/routes.test.tsx: the real /session/login
// contract returns only { accessToken }, and the display principal is
// decoded from the token payload, so a test JWT just needs a
// base64url-decodable payload segment.
function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
}

// AuthContext exposes no way to seed a principal other than a real login()
// call, and that call is async: this harness calls login() once on mount and
// withholds AppRoutes (so RequireAuth never runs, never redirects) until it
// resolves. Once resolved, AppRoutes mounts fresh at whatever the current
// MemoryRouter entry is, already authenticated.
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

// ONE payload that satisfies every shape this file's routes read on mount. The
// login call reads `accessToken`, TilesPage reads `tiles` + `watermark`, and the
// list/detail pages read their own array field; each ignores what it does not
// recognise, so a single superset body lets any route be an entry point.
//
// Before this, the stub returned only `{ accessToken }`, so any route whose page
// fetches on mount rendered an empty tree and the assertion failed with a
// confusing "no navigation element" rather than anything about the route.
function stubBody(token: string): string {
  return JSON.stringify({
    accessToken: token,
    tiles: {
      requestsReceived: 0,
      totalBatches: 4,
      pendingQrAwaitingBatch: { count: 0, oldestAgeDays: null },
      pendingPrintVendorPickup: 0,
      dispatchedNotDelivered: 0,
      deliveredNotActivated: 0,
      damagedReplacementOpen: 0,
      activatedSuccessfully: 0,
    },
    watermark: { asOf: null, perTopic: {} },
    rows: [],
    batches: [],
    entries: [],
    dispatches: [],
    vendors: [],
  })
}

async function renderAuthed(initialEntry: string, psr = 'role:ops'): Promise<void> {
  const fakeToken = makeFakeJwt({ sub: 'ops-1', psr })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    stubBody(fakeToken),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
  render(
    <MemoryRouter
      initialEntries={[initialEntry]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AuthProvider>
        <AuthedAppRoutes onError={(e) => { throw e }} />
      </AuthProvider>
    </MemoryRouter>,
  )
  await screen.findByRole('navigation', { name: /main/i })
}

describe('ops-portal app shell + navigation', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })
  // Explicit cleanup: vitest.config.ts does not set test.globals, so RTL's
  // automatic afterEach never registers (same pattern as routes.test.tsx).
  afterEach(() => { cleanup() })

  // /queues and /uploads (not /dashboards or /reports): TilesPage/ReportPage
  // fetch real analytics aggregates and only get reskinned/hardened for a
  // malformed response in Task 4/5. QueuesPage and UploadsPage render their
  // heading unconditionally and their own tabs (BankUploadPage) do not fetch
  // on mount, so they render deterministically off the single login-only
  // fetch stub, matching the pattern already proven by test/routes.test.tsx.
  it('renders the AppShell frame (brand mark) around the routed content', async () => {
    await renderAuthed('/queues')
    // "Ops Console" is the AppShell brand mark's subtitle (src/ui/AppShell.tsx
    // TopBar/Sidebar); it does not exist anywhere in the pre-reskin plain
    // Nav.tsx + hand-rolled Shell layout, so this is a faithful red/green
    // marker of the shell having actually been swapped for AppShell.
    expect(screen.getByText(/Ops Console/i)).toBeTruthy()
    expect(await screen.findByRole('heading', { name: /^queues$/i })).toBeTruthy()
  })

  it('the nav lists exactly the 10 shown sections, no master-data admin/CRUD route', async () => {
    await renderAuthed('/queues')
    const nav = screen.getByRole('navigation', { name: /main/i })
    const links = within(nav).getAllByRole('link')
    const names = links.map((link) => link.textContent?.trim())
    // Master-data is READ-ONLY (FR-11 deferred): no admin/CRUD entry.
    //
    // Redesign step 1 (object-first IA): "Dashboards" is now "Command Center"
    // and "Fulfillment" is now "Batches". Step 7 ADDS Merchants, which was
    // absent only because nav option B ships sections backed by a read that
    // exists and there was no merchant list endpoint; `GET /ops/merchants`
    // (ruling 1b) is that read. Compared as a SET, because the sidebar groups
    // these links under headings, so document order is a presentation choice
    // while "which sections exist" is the invariant worth guarding.
    //
    // Workflow was REMOVED on 13 Aug 2026: it had become a second home for
    // surfaces that already had one (the bank upload lived inside it), so an
    // operator had two routes to the same work with no rule for choosing.
    //
    // D-24 (T6.6) ADDS Damage cases, beside Queues under Operations: both are
    // work an operator picks up and moves along, as opposed to an object they
    // look at. The read had existed at the edge since FR08-2 with no surface at
    // all, which is most of why those statuses were stale.
    //
    // Reports is HIDDEN as of 17 Aug 2026 (HIDDEN_ROUTES) while the Insights
    // work is in flight, so it is absent here while /reports itself still
    // resolves. See the deep-link test below, which is what guards that.
    expect([...names].sort()).toEqual(
      ['Activation', 'Batches', 'Command Center', 'Damage cases', 'Dispatches', 'Inventory', 'Master Data', 'Merchants', 'Queues', 'Uploads'],
    )
    expect(within(nav).queryByRole('link', { name: /edit|create|manage|admin/i })).toBeNull()
  })

  it('groups the nav under the object-first headings, less the emptied Insights', async () => {
    await renderAuthed('/queues')
    const nav = screen.getByRole('navigation', { name: /main/i })
    for (const heading of ['Overview', 'Pipeline', 'Operations', 'Setup']) {
      expect(within(nav).getByText(heading)).toBeTruthy()
    }
    // Insights held only Reports, so hiding that item empties the group and its
    // heading goes with it rather than titling an empty list. Same rule the CS
    // test below relies on for Setup.
    expect(within(nav).queryByText('Insights')).toBeNull()
  })

  // The renames must not strand a bookmark or a link in someone's notes.
  //
  // The destination page fetches on mount, so it re-renders AFTER the nav first
  // appears. A synchronous query between those two renders saw an empty tree and
  // made this suite fail 3 runs in 5. Both queries retry, so the assertion waits
  // for the redirect to settle instead of racing it.
  async function currentSectionLabel(): Promise<string> {
    const nav = await screen.findByRole('navigation', { name: /main/i })
    const current = await within(nav).findByRole('link', { current: 'page' })
    return current.textContent?.trim() ?? ''
  }

  it('redirects the old /dashboards route to Command Center', async () => {
    await renderAuthed('/dashboards')
    expect(await currentSectionLabel()).toBe('Command Center')
  })

  it('redirects the old /fulfillment route to Batches', async () => {
    await renderAuthed('/fulfillment')
    expect(await currentSectionLabel()).toBe('Batches')
  })

  // P-C, fixed as a side effect of the rename: the batch detail page used to
  // sit at /batches/:id while its list sat at /fulfillment, sharing no prefix,
  // so the sidebar highlighted nothing and the breadcrumb read "Ops Console".
  // The detail route is now a child of its own list route.
  //
  // Renders AppShell DIRECTLY rather than through AppRoutes, because the thing
  // under test is the shell's section resolution for a detail path, not
  // BatchDetailPage's own data fetching. Going through the router would make
  // this test fail for reasons that have nothing to do with the nav.
  it('keeps Batches marked as the current section on a batch DETAIL route', () => {
    render(
      <MemoryRouter
        initialEntries={['/batches/btch_50000000008008000000000001']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <AppShell><div>detail content</div></AppShell>
        </AuthProvider>
      </MemoryRouter>,
    )
    const nav = screen.getByRole('navigation', { name: /main/i })
    const current = within(nav).getByRole('link', { current: 'page' })
    expect(current.textContent?.trim()).toBe('Batches')
  })

  // The same prefix match drives the top-bar crumb. Before the rename it read
  // "Ops Console" here, the fallback for a path belonging to no section.
  it('names the section in the top bar on a batch DETAIL route', () => {
    render(
      <MemoryRouter
        initialEntries={['/batches/btch_50000000008008000000000001']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <AppShell><div>detail content</div></AppShell>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(screen.getAllByText('Batches').length).toBeGreaterThan(1)
  })

  // The crumb root was the literal string "Operations" on every screen, from
  // before the nav had groups. With five real groups it is wrong on most of
  // them: Command Center is under Overview, Reports under Insights. It now
  // names the section's ACTUAL group.
  it.each([
    ['/command-center', 'Overview'],
    ['/merchants', 'Pipeline'],
    ['/batches', 'Pipeline'],
    ['/reports', 'Insights'],
    ['/masterdata', 'Setup'],
    ['/queues', 'Operations'],
  ])('names the real group in the crumb for %s', (path, group) => {
    render(
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <AppShell><div>content</div></AppShell>
        </AuthProvider>
      </MemoryRouter>,
    )
    const header = document.querySelector('header')
    expect(header?.textContent).toContain(group)
  })

  // D-29 (damage workflow, B7): customer_support's sidebar drops the sections
  // that role cannot use. DISPLAY CONVENIENCE ONLY, never authorization
  // (S24/T14): the edge still decides every request, and the nav grants or
  // revokes nothing. The role rides the token's psr the same way every role
  // does, so the test mints it the same way.
  it('customer_support sees no Uploads or Master Data nav item, while the work views stay', async () => {
    await renderAuthed('/queues', 'role:customer_support')
    const nav = screen.getByRole('navigation', { name: /main/i })
    const names = within(nav).getAllByRole('link').map((link) => link.textContent?.trim())

    expect(names).not.toContain('Uploads')
    expect(names).not.toContain('Master Data')
    // The views D-29 keeps for CS are all still offered. Reports is NOT among
    // them any more, and not because of this role: HIDDEN_ROUTES drops it for
    // everyone while the Insights work is in flight.
    for (const kept of ['Dispatches', 'Merchants', 'Damage cases']) {
      expect(names).toContain(kept)
    }
    // The Setup group held only Master Data, so its heading goes with it
    // rather than titling an empty list.
    expect(within(nav).queryByText('Setup')).toBeNull()
  })

  it('an admin still sees Uploads and Master Data: the gate is the CS role, not a new default', async () => {
    await renderAuthed('/queues', 'role:admin')
    const nav = screen.getByRole('navigation', { name: /main/i })
    const names = within(nav).getAllByRole('link').map((link) => link.textContent?.trim())
    expect(names).toContain('Uploads')
    expect(names).toContain('Master Data')
  })

  it('routing switches the content region between two routes', async () => {
    await renderAuthed('/queues')
    expect(await screen.findByRole('heading', { name: /^queues$/i })).toBeTruthy()

    const nav = screen.getByRole('navigation', { name: /main/i })
    // ANCHORED. An unanchored /uploads/i was unambiguous only by luck: any later
    // section whose label contains "uploads" would make this throw on ambiguity
    // rather than fail on the routing it is actually testing.
    await userEvent.click(within(nav).getByRole('link', { name: /^uploads$/i }))

    expect(await screen.findByRole('heading', { name: /^uploads$/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^queues$/i })).toBeNull()
  })
})
