import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../src/auth/AuthContext.js'
import { AppRoutes } from '../src/routes.js'
import { clearAccessToken } from '../src/api/tokenStore.js'

// Same fake-JWT approach as apps/ops-portal/test/routes.test.tsx: the real
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
      login({ handle: 'vendor-op', password: 'pw', totp: '123456' }).catch(onError)
    }
  }, [login, principal, onError])
  if (principal === null) return null
  return <AppRoutes />
}

describe('vendor-portal routing', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })
  // Explicit cleanup: vitest.config.ts does not set test.globals, so RTL's
  // automatic afterEach never registers (same pattern as login.test.tsx).
  afterEach(() => { cleanup() })

  it('an unauthenticated visit to / redirects to /login', () => {
    render(
      <MemoryRouter
        initialEntries={['/']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText(/username/i)).toBeTruthy()
  })

  it('an authenticated visit renders the work queue and the nav lists only vendor sections', async () => {
    const fakeToken = makeFakeJwt({ sub: 'vendor-op-1', psr: 'role:vendor_operator', scope: { vndr: 'vndr_1' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/vendor/work-queue')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ accessToken: fakeToken }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    render(
      <MemoryRouter
        initialEntries={['/']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <AuthedAppRoutes onError={(e) => { throw e }} />
        </AuthProvider>
      </MemoryRouter>,
    )

    // The work-queue heading renders at "/".
    expect(await screen.findByRole('heading', { name: /work queue/i })).toBeTruthy()

    // The nav lists exactly the vendor sections.
    expect(screen.getByRole('link', { name: /work queue/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /history/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /returns/i })).toBeTruthy()

    // No ops-only section leaks into the vendor nav.
    expect(screen.queryByRole('link', { name: /master data/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /dashboards/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /operations/i })).toBeNull()

    // The logged-in principal and a logout control are shown.
    expect(screen.getByRole('button', { name: /logout/i })).toBeTruthy()
  })
})
