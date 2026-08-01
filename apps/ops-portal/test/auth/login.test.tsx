import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { LoginPage } from '../../src/auth/LoginPage.js'
import { Nav } from '../../src/components/Nav.js'
import { getAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The real auth-edge /session/login contract (verified in
// apps/auth-edge/src/login.controller.ts) returns ONLY { accessToken }, no
// principal object. The display principal is decoded from the token itself,
// so the test constructs a real (unsigned, fake-signature) JWT string whose
// payload base64url-decodes to the claims we expect the UI to display. The
// real D3 access token carries no top-level `role` claim, only `psr`
// (packages/authz/src/claims.ts LeanClaim); class-3 human logins mint it as
// `role:<name>` (services/auth/src/login.ts), so the fixture matches that
// shape rather than an unrealistic top-level `role` field.
function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
}

function LoginHarness() {
  const { principal } = useAuth()
  return principal ? <Nav /> : <LoginPage />
}

describe('auth login', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })
  // vitest.config.ts does not set test.globals, so @testing-library/react's
  // automatic per-test cleanup (which relies on detecting a global afterEach)
  // never registers; without this explicit call, DOM from a prior `it()`'s
  // render leaks into the next one (multiple "Sign in" buttons found).
  afterEach(() => { cleanup() })

  it('login stores the access token in memory (not storage), sets the principal, and the Nav shows the derived role label', async () => {
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accessToken: fakeToken }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.type(screen.getByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('u-1')).toBeTruthy()
    // The psr claim (`role:ops`) is derived into the display label with the
    // `role:` prefix stripped (AuthContext.deriveRoleLabel), not shown raw.
    expect(await screen.findByText('ops')).toBeTruthy()
    expect(getAccessToken()).toBe(fakeToken)
    expect(JSON.stringify(localStorage)).not.toContain(fakeToken)
    expect(JSON.stringify(sessionStorage)).not.toContain(fakeToken)
  })

  it('a failed login (401) surfaces an error and does not set a token or principal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(null), { status: 401, headers: { 'content-type': 'application/json' } })))
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong')
    await userEvent.type(screen.getByLabelText(/totp/i), '000000')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(getAccessToken()).toBeNull()
    expect(screen.queryByText('u-1')).toBeNull()
  })

  it('a malformed token on a 200 response fails safely (no token, no principal, no crash)', async () => {
    // decodeTokenClaims throws BEFORE setAccessToken/setPrincipal (AuthContext.login):
    // a 200 with a garbage accessToken must still land the user on the failed-login
    // path, exactly like a 401, never with a token in memory or a principal set.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accessToken: 'not-a-valid-jwt' }), { status: 200, headers: { 'content-type': 'application/json' } })))
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.type(screen.getByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(getAccessToken()).toBeNull()
    expect(screen.queryByText('u-1')).toBeNull()
    expect(screen.getByLabelText(/username/i)).toBeTruthy()
  })

  it('logout clears the token and principal', async () => {
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/session/login')) {
        return new Response(JSON.stringify({ accessToken: fakeToken }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // /session/logout: 204 No Content
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.type(screen.getByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('u-1')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /logout/i }))
    expect(await screen.findByLabelText(/username/i)).toBeTruthy()
    expect(getAccessToken()).toBeNull()
  })
})
