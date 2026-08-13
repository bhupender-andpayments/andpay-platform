import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../src/auth/AuthContext.js'
import { AppRoutes } from '../src/routes.js'
import { clearAccessToken } from '../src/api/tokenStore.js'

// Phase 7 task 3 (reskin) removed the old always-on plain header this test
// used to assert (`/AndPayments Ops/i`): that literal text only ever lived
// in a header App.tsx rendered outside RequireAuth, and it was replaced by
// the branded AppShell frame (src/ui/AppShell.tsx), whose brand mark splits
// "AndPayments" and "Ops Console" across separate elements, so the literal
// can never match again. This is a stale assertion fix (test(ops-portal)),
// not a shell change: it asserts the same underlying fact, "the app shell
// renders", via a stable role/landmark instead of a brand-text literal that
// breaks on the next copy tweak.
//
// Same fake-JWT + login-harness approach as test/shell/nav.test.tsx: the
// real /session/login contract returns only { accessToken }, and the
// display principal is decoded from the token payload, so a test JWT just
// needs a base64url-decodable payload segment. AuthedAppRoutes withholds
// AppRoutes until the login resolves so RequireAuth never redirects.
function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
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

describe('ops-portal smoke', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })
  // Explicit cleanup: vitest.config.ts does not set test.globals, so RTL's
  // automatic afterEach never registers (same pattern as the other suites).
  afterEach(() => { cleanup() })

  it('renders the app shell', async () => {
    const fakeToken = makeFakeJwt({ sub: 'ops-1', psr: 'role:ops' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ accessToken: fakeToken }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    // /queues, not /dashboards: TilesPage fetches a real analytics aggregate
    // and is only hardened against a malformed mocked response in Task 4;
    // QueuesPage renders its heading unconditionally off the same
    // login-only stub, matching test/routes.test.tsx and
    // test/shell/nav.test.tsx's already-proven pattern.
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

    // The AppShell frame renders: a stable nav landmark with a real section
    // link, and the routed feature heading, not a brand-text literal.
    expect(await screen.findByRole('navigation', { name: /main/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /queues/i })).toBeTruthy()
    // findBy, not getBy: a bare /queues now REDIRECTS to /queues/quarantine
    // (the tab moved into the url on 2026-08-12), so the heading arrives one
    // navigation later rather than on the first render.
    expect(await screen.findByRole('heading', { name: /^queues$/i })).toBeTruthy()
  })
})
