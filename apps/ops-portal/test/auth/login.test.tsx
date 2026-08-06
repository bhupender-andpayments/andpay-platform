import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { LoginPage } from '../../src/auth/LoginPage.js'
import { AppShell } from '../../src/ui/AppShell.js'
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

// Phase 7 Task 13a: mounts AppShell instead of the removed src/components/
// Nav.tsx. AppShell (src/ui/AppShell.tsx) is the sidebar the live app
// actually renders (routes.tsx's Shell wraps AppShell, not a standalone Nav
// component; see the Task 3 report's disclosed Nav/AppShell duplication
// finding) and its own Sidebar renders the identical principal.sub /
// principal.roleLabel footer text and an accessibly-named Logout button that
// Nav.tsx used to, so every assertion below is unchanged in meaning, only
// the mounted component differs. AppShell needs a Router (NavLink/
// useLocation), already supplied by the surrounding MemoryRouter below.
function LoginHarness() {
  const { principal } = useAuth()
  return principal ? (
    <AppShell>
      <div />
    </AppShell>
  ) : (
    <LoginPage />
  )
}

// Answers /session/login the way auth-edge actually does for an ENROLLED
// principal with a correct password: a password-only request reports that the
// second factor is outstanding (200, mfaRequired, no token), and only a request
// carrying a code yields a session. A 401 from this endpoint now means the
// credentials themselves were wrong. `calls`, when passed, records only the
// login requests, never the mount-time rehydrate.
function stubLoginFetch(fakeToken: string, calls?: Array<{ url: string; init: RequestInit }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/session/rehydrate')) return new Response(null, { status: 401 })
    if (calls) calls.push({ url, init })
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { totp?: string }) : {}
    // Password-only on an ENROLLED principal: the password verified, the code
    // is outstanding. No token, no cookie, and NOT a 401 (a 401 now means the
    // credentials themselves were wrong).
    if (body.totp === undefined) {
      return new Response(JSON.stringify({ mfaRequired: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ accessToken: fakeToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

describe('auth login', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })
  // vitest.config.ts does not set test.globals, so @testing-library/react's
  // automatic per-test cleanup (which relies on detecting a global afterEach)
  // never registers; without this explicit call, DOM from a prior `it()`'s
  // render leaks into the next one (multiple "Sign in" buttons found).
  afterEach(() => { cleanup() })

  it('login stores the access token in memory (not storage), sets the principal, and the shell shows the derived role label', async () => {
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    // URL-discriminating: AuthProvider now also fires a mount-time
    // POST /session/rehydrate (Phase 7 GATE 2). A non-discriminating mock
    // would answer that call with the same token and auto-authenticate
    // before the test acts, pre-empting the login flow under test here. The
    // rehydrate call gets a 401 (as a cold-start SPA with no refresh cookie
    // would), leaving the credentials step to actually exercise login().
    stubLoginFetch(fakeToken)
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.type(await screen.findByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('u-1')).toBeTruthy()
    // The psr claim (`role:ops`) is derived into the display label with the
    // `role:` prefix stripped (AuthContext.deriveRoleLabel), not shown raw. The
    // sidebar title-cases it for display, since the role is what identifies the
    // signed-in principal (the token carries no human name).
    expect(await screen.findByText('Ops')).toBeTruthy()
    expect(getAccessToken()).toBe(fakeToken)
    expect(JSON.stringify(localStorage)).not.toContain(fakeToken)
    expect(JSON.stringify(sessionStorage)).not.toContain(fakeToken)
  })

  it('a wrong password fails on the credentials step and never reaches the code step', async () => {
    // Previously a wrong password silently advanced to the code screen and
    // failed there with a vague message, so the operator never learned which
    // field was wrong. The credentials are judged on the screen that collected
    // them now.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(null), { status: 401, headers: { 'content-type': 'application/json' } })))
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    // Still on the credentials step: no code field was ever shown.
    expect(screen.queryByLabelText(/totp/i)).toBeNull()
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
    expect(getAccessToken()).toBeNull()
    expect(screen.queryByText('u-1')).toBeNull()
  })

  it('a malformed token on a 200 response fails safely (no token, no principal, no crash)', async () => {
    // decodeTokenClaims throws BEFORE setAccessToken/setPrincipal (AuthContext.login):
    // a 200 with a garbage accessToken must still land the user on the failed-login
    // path, exactly like a 401, never with a token in memory or a principal set.
    stubLoginFetch('not-a-valid-jwt')
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.type(await screen.findByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(getAccessToken()).toBeNull()
    expect(screen.queryByText('u-1')).toBeNull()
    // A failed login (a uniform 401) returns to the credentials step, per
    // AuthContext/LoginPage's unchanged error handling, so the username field
    // is reachable again (not the totp field, which the credentials step does
    // not render).
    expect(screen.getByLabelText(/username/i)).toBeTruthy()
  })

  it('logout clears the token and principal', async () => {
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/session/login')) {
        // Mirror the edge: the credentials step's password-only probe cannot
        // reach the AAL2 floor and is a 401; only the request carrying a code
        // returns a session.
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { totp?: string }) : {}
        if (body.totp === undefined) {
          return new Response(JSON.stringify({ mfaRequired: true }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ accessToken: fakeToken }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // /session/logout: 204 No Content
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuthProvider><LoginHarness /></AuthProvider></MemoryRouter>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.type(await screen.findByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('u-1')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /logout/i }))
    expect(await screen.findByLabelText(/username/i)).toBeTruthy()
    expect(getAccessToken()).toBeNull()
  })
})
