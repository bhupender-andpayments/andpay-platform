import { StrictMode } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../../src/auth/AuthContext.js'
import { getAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// Phase 7 GATE 2 portal slice (un-drops Task 2): AuthProvider fires a single
// mount-time POST /session/rehydrate (cookie-only, no bearer) so a cold
// browser reload silently re-authenticates the operator instead of falling
// back to the login page. These tests exercise ONLY that mount bootstrap,
// not login/logout (see login.test.tsx), and assert it never loops.
function makeFakeJwt(claims: Record<string, unknown>): string {
  const json = JSON.stringify(claims)
  const base64 = btoa(json)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `header.${base64url}.signature`
}

function MountHarness() {
  const { principal } = useAuth()
  return <div data-testid="principal">{principal ? principal.sub : 'unauthenticated'}</div>
}

describe('AuthProvider mount-time rehydrate', () => {
  afterEach(() => { cleanup(); clearAccessToken(); vi.unstubAllGlobals() })

  it('(a) a 2xx /session/rehydrate on mount authenticates silently, with no /session/login call', async () => {
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({ accessToken: fakeToken }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    render(<AuthProvider><MountHarness /></AuthProvider>)

    await waitFor(() => expect(screen.getByTestId('principal').textContent).toBe('u-1'))
    expect(getAccessToken()).toBe(fakeToken)
    expect(calls.some((u) => u.endsWith('/session/rehydrate'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/session/login'))).toBe(false)
  })

  it('(b) a 401 /session/rehydrate falls through to unauthenticated, called exactly once (no retry loop)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<AuthProvider><MountHarness /></AuthProvider>)

    // No principal ever appears; assert on the stable unauthenticated state
    // after microtasks settle rather than racing the effect.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('principal').textContent).toBe('unauthenticated')
    expect(getAccessToken()).toBeNull()

    // Give any accidental retry a chance to fire, then confirm it never did.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // Guards the StrictMode bug class specifically: React 18 StrictMode (dev
  // only, active via main.tsx) runs setup1 -> cleanup1 -> setup2 on mount.
  // /session/rehydrate rotates a one-time-use refresh token with reuse
  // detection (services/auth/src/refresh.ts); a second real fire under
  // StrictMode would present the SAME refresh cookie twice, which the
  // rotation treats as reuse and revokes the entire family, logging the
  // operator out. The fix must fire the fetch exactly once AND apply its
  // 2xx result (a cancelled-flag cleanup that discards the result instead of
  // preventing the second fire is the exact regression this guards against).
  it('(c) under StrictMode, exactly ONE /session/rehydrate fires and its 2xx result authenticates', async () => {
    const fakeToken = makeFakeJwt({ sub: 'u-1', psr: 'role:ops' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accessToken: fakeToken }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <StrictMode>
        <AuthProvider><MountHarness /></AuthProvider>
      </StrictMode>,
    )

    await waitFor(() => expect(screen.getByTestId('principal').textContent).toBe('u-1'))
    expect(getAccessToken()).toBe(fakeToken)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Give a would-be second fire a chance to land, then confirm it never did.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
