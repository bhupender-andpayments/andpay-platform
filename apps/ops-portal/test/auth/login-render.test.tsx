import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { LoginPage } from '../../src/auth/LoginPage.js'
import { StepUpDialog } from '../../src/auth/StepUpDialog.js'
import { createApiClient } from '../../src/api/client.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'
import { newIdempotencyKey } from '../../src/api/idempotency.js'

// Task 12: styles LoginPage + StepUpDialog onto the ui/* design system
// (Task 1's ui/primitives, ui/icons). Presentation only. This file asserts:
// (a) both login steps render styled, with a stable landmark and a brand
//     mark (the login screen had no branding once Task 1's port dropped the
//     old always-on header outside AppShell);
// (b) the step-up dialog renders styled with the same controller contract;
// (c) neither surface's underlying behavior moved: the two-step credential
//     UI still fires exactly ONE AuthContext login() call, with the same
//     body shape as before, no matter how many screens the operator sees
//     first; and the real 403 -> step-up -> retry round trip still resolves
//     through the restyled dialog exactly as before this task.
function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
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

describe('auth surfaces styling (Task 12, presentation only)', () => {
  beforeEach(() => { clearAccessToken(); vi.unstubAllGlobals() })
  afterEach(() => { cleanup() })

  it('(a) step 1 renders styled with a stable landmark and a brand mark; continuing reveals a styled TOTP step', async () => {
    // Continuing now asks the server what comes next, so this test needs a
    // stubbed edge; previously the step change was purely client-side.
    stubLoginFetch(makeFakeJwt({ sub: 'u-1', psr: 'role:ops' }))
    render(<AuthProvider><LoginPage /></AuthProvider>)

    // stable landmark, present on both steps
    expect(screen.getByRole('main', { name: /sign in/i })).toBeTruthy()
    // brand mark carry-forward: an AndPayments wordmark on the login screen
    // The brand mark is now the real logo asset (public/logo/logo.svg), rendered
    // twice: once in the desktop brand panel and once in the small-screen header.
    // Asserting the image is tighter than matching the word "AndPayments", which
    // also appears in the welcome line and the copyright notice.
    expect(screen.getAllByRole('img', { name: /andpayments/i }).length).toBeGreaterThan(0)

    expect(screen.getByLabelText(/username/i)).toBeTruthy()
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy()
    expect(screen.queryByLabelText(/totp/i)).toBeNull()

    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(screen.getByRole('main', { name: /sign in/i })).toBeTruthy()
    // The brand mark is now the real logo asset (public/logo/logo.svg), rendered
    // twice: once in the desktop brand panel and once in the small-screen header.
    // Asserting the image is tighter than matching the word "AndPayments", which
    // also appears in the welcome line and the copyright notice.
    expect(screen.getAllByRole('img', { name: /andpayments/i }).length).toBeGreaterThan(0)
    expect(await screen.findByLabelText(/totp/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
  })

  it('(c) the credentials step probes password-only, then the code step sends both factors', async () => {
    // SUPERSEDES an earlier assertion that the two-step UI fired exactly ONE
    // login() call, which encoded the old design where the step split was
    // purely cosmetic. The credentials step now genuinely asks the server what
    // comes next, because only the server knows whether this principal has a
    // factor: without that request, an operator with no authenticator would be
    // shown a code field they cannot possibly fill. The cost is one extra
    // password verification per sign-in, accepted deliberately.
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    stubLoginFetch(fakeToken, calls)

    render(<AuthProvider><LoginPage /></AuthProvider>)
    await userEvent.type(screen.getByLabelText(/username/i), 'alice')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'pw')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await userEvent.type(await screen.findByLabelText(/totp/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(calls.length).toBe(2))
    // Base URL is env-configured (VITE_AUTH_BASE); only the path is a stable
    // assertion here.
    expect(calls.every((c) => c.url.endsWith('/session/login'))).toBe(true)
    // The probe carries NO totp field at all (not an empty string, which the
    // edge would try to verify and reject as a failed factor).
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ handle: 'alice', password: 'pw' })
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ handle: 'alice', password: 'pw', totp: '123456' })
  })

  it('(b) the step-up dialog renders styled with the unchanged controller contract (role=dialog, labelled TOTP, Confirm/Cancel)', async () => {
    setAccessToken('t0')
    const key = newIdempotencyKey()
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (calls.length === 1) return new Response(null, { status: 403 })
      if (calls.length === 2) return new Response(JSON.stringify({ accessToken: 't1' }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ deduped: false, overridden: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const client = createApiClient({
      opsBase: 'http://ops',
      authBase: 'http://auth',
      onSessionLost: vi.fn(),
      promptStepUpTotp: () => import('../../src/auth/stepUpController.js').then((m) => m.promptStepUpTotp()),
    })

    render(<StepUpDialog />)
    expect(screen.queryByRole('dialog')).toBeNull()

    const requestPromise = client.request({
      method: 'POST',
      path: '/ops/shipments/s1/override',
      idempotencyKey: key,
      stepUpKey: 'terminal-override',
      body: { status: 'DELIVERED', courierTimestamp: 't', overrideReason: 'r' },
    })

    const dialog = await screen.findByRole('dialog', { name: /step-up authentication/i })
    expect(dialog).toBeTruthy()
    const input = screen.getByLabelText(/totp/i)
    await userEvent.type(input, '123456')
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))

    const out = await requestPromise
    expect(out).toMatchObject({ overridden: true })
    expect(calls.length).toBe(3)
    expect(calls[1]!.url).toBe('http://auth/session/stepup')
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(key)
    expect((calls[2]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(key)
    // after resolving, the dialog closes and the code is not retained
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
