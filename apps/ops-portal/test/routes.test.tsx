import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../src/auth/AuthContext.js'
import { AppRoutes } from '../src/routes.js'
import { clearAccessToken } from '../src/api/tokenStore.js'

// Same fake-JWT approach as test/auth/login.test.tsx: the real
// /session/login contract returns only { accessToken }, and the display
// principal is decoded from the token payload, so a test JWT just needs a
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

describe('ops-portal routing', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })
  // Explicit cleanup: vitest.config.ts does not set test.globals, so RTL's
  // automatic afterEach never registers (same pattern as login.test.tsx).
  afterEach(() => { cleanup() })

  // AWAITED, not synchronous. P-C made RequireAuth wait for the mount-time
  // rehydrate to settle before deciding, because redirecting on the first tick
  // threw away the operator's destination on every cold deep link. So an
  // unauthenticated visitor now renders nothing for exactly one round-trip and
  // then gets the login page. The redirect still happens; it is one tick later.
  //
  // The second assertion is the load-bearing one: the feature route must never
  // render. Waiting must not become a window where a protected screen paints.
  it('an unauthenticated visit to a feature route redirects to /login', async () => {
    render(
      <MemoryRouter
        initialEntries={['/queues']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByLabelText(/username/i)).toBeTruthy()
    expect(screen.queryByText(/queues/i)).toBeNull()
  })

  it('an authenticated visit renders the feature route and the nav lists the sections', async () => {
    const fakeToken = makeFakeJwt({ sub: 'ops-1', role: 'ops' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ accessToken: fakeToken }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    render(
      <MemoryRouter
        initialEntries={['/queues']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <AuthedAppRoutes onError={(e) => { throw e }} />
        </AuthProvider>
      </MemoryRouter>,
    )

    // The queues placeholder heading (task 11 replaces its content).
    expect(await screen.findByRole('heading', { name: /queues/i })).toBeTruthy()

    // The nav lists every feature section.
    expect(screen.getByRole('link', { name: /command center/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /reports/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /master data/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /uploads/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /actions/i })).toBeTruthy()

    // The logged-in principal and a logout control are shown.
    expect(screen.getByText(/ops-1/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /logout/i })).toBeTruthy()
  })
})
