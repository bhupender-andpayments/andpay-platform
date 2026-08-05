import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { AppRoutes } from '../../src/routes.js'
import { clearAccessToken } from '../../src/api/tokenStore.js'

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

async function renderAuthed(initialEntry: string): Promise<void> {
  const fakeToken = makeFakeJwt({ sub: 'ops-1', psr: 'role:ops' })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ accessToken: fakeToken }),
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

  it('the nav lists exactly the 6 real sections, no master-data admin/CRUD route', async () => {
    await renderAuthed('/queues')
    const nav = screen.getByRole('navigation', { name: /main/i })
    const links = within(nav).getAllByRole('link')
    const names = links.map((link) => link.textContent?.trim())
    // Master-data is READ-ONLY (FR-11 deferred): the surface set is exactly
    // the 6 real sections, in the routes.tsx order, no extra admin/CRUD entry.
    expect(names).toEqual(['Dashboards', 'Reports', 'Queues', 'Master Data', 'Uploads', 'Operations'])
    expect(within(nav).queryByRole('link', { name: /edit|create|manage|admin/i })).toBeNull()
  })

  it('routing switches the content region between two routes', async () => {
    await renderAuthed('/queues')
    expect(await screen.findByRole('heading', { name: /^queues$/i })).toBeTruthy()

    const nav = screen.getByRole('navigation', { name: /main/i })
    await userEvent.click(within(nav).getByRole('link', { name: /uploads/i }))

    expect(await screen.findByRole('heading', { name: /^uploads$/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^queues$/i })).toBeNull()
  })
})
