import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createApiClient, sendOnce } from '../api/client.js'
import { getAccessToken, setAccessToken, clearAccessToken } from '../api/tokenStore.js'
import { login as loginEndpoint, logout as logoutEndpoint } from '../api/endpoints.js'
import { authBase, opsBase } from '../lib/env.js'
import { promptStepUpTotp } from './stepUpController.js'
import { StepUpDialog } from './StepUpDialog.js'

// The display-only identity shown in the UI (e.g. "signed in as ..."). It is
// NOT the authorization principal: every request still carries the Bearer
// token and every authz decision is re-checked at the edge (S24/T14).
export interface Principal {
  sub: string
  roleLabel?: string
}

// Derives a human-readable role label from the psr (permission-set
// reference) claim. The real D3 access token (packages/authz/src/claims.ts
// LeanClaim.psr) carries no top-level `role` field; class-3 (human) logins
// mint psr as `role:<name>` (services/auth/src/login.ts, e.g. `role:ops`,
// `role:admin`). Strip that prefix when present; otherwise fall back to the
// raw psr string so an unexpected future format still shows something
// instead of silently vanishing.
function deriveRoleLabel(psr: string): string {
  const prefix = 'role:'
  return psr.startsWith(prefix) ? psr.slice(prefix.length) : psr
}

// Decodes the middle (payload) segment of a JWT WITHOUT verifying its
// signature. This is DISPLAY-ONLY: the decoded claims are used solely to
// render who is signed in, and are NEVER consulted for any authorization
// decision. The edge is the sole authority and re-verifies the token
// (signature, issuer, audience, mode) on every call (S24/T14). A malformed
// token throws so the caller can treat the login attempt as failed.
export function decodeTokenClaims(token: string): Principal {
  const segments = token.split('.')
  const payload = segments[1]
  if (payload === undefined || payload === '') throw new Error('malformed token: missing payload segment')
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const json = atob(padded)
  const claims = JSON.parse(json) as { sub?: unknown; psr?: unknown }
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('malformed token: missing sub claim')
  const roleLabel = typeof claims.psr === 'string' && claims.psr !== '' ? deriveRoleLabel(claims.psr) : undefined
  return roleLabel === undefined ? { sub: claims.sub } : { sub: claims.sub, roleLabel }
}

export interface AuthContextValue {
  principal: Principal | null
  /**
   * True until the mount-time silent rehydrate has SETTLED, either way.
   *
   * P-C: without this, a cold reload of any deep link was lost. The in-memory
   * access token is gone on a fresh page load, so the rehydrate below is async,
   * and RequireAuth rendered on the same tick with a null principal and
   * redirected to /login immediately. By the time the session came back the
   * router had already left, and the login route sent the operator to the
   * landing page. Every bookmark and every pasted link died that way.
   *
   * Consumers must WAIT rather than treat this as unauthenticated. It is not an
   * authorization signal (S24/T14): the edge still decides every request.
   */
  bootstrapping: boolean
  // Exposed so feature pages (Task 10's dashboards, and the tasks after it)
  // can call the typed endpoint functions under the same interceptor pipeline
  // (401 refresh, 403 step-up) the login/logout calls already use, rather
  // than each page constructing its own client with divergent deps.
  client: ReturnType<typeof createApiClient>
  // Resolves to the enrollment outcome so the login screen can route a
  // first-time operator to TOTP setup. `enrollmentRequired` means NO session
  // was established: `principal` stays null and the app stays locked.
  login(body: { handle: string; password: string; totp: string }): Promise<LoginOutcome>
  logout(): Promise<void>
}

export type LoginOutcome =
  // A real session: the principal is set and the app is reachable.
  | { kind: 'session' }
  // The password verified but the enrolled factor was not presented yet.
  | { kind: 'mfa-required' }
  // The password verified and this principal has no factor at all.
  | { kind: 'enrollment-required'; principalId: string }

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  // Starts true: on a cold load the rehydrate below has not run yet, and
  // "no principal" must not be read as "logged out" until it has.
  const [bootstrapping, setBootstrapping] = useState(true)

  // An unrecoverable session loss (both refresh attempts exhausted): drop the
  // display principal so the app falls back to the login page.
  const onSessionLost = useCallback(() => { setPrincipal(null) }, [])

  // Pulled out of the client's useMemo so the mount-time rehydrate bootstrap
  // below can reuse the exact same base URLs via sendOnce, without touching
  // api/client.ts or duplicating the env lookups.
  const clientDeps = useMemo(() => ({
    opsBase: opsBase(),
    authBase: authBase(),
    onSessionLost,
    promptStepUpTotp,
  }), [onSessionLost, promptStepUpTotp])

  const client = useMemo(() => createApiClient(clientDeps), [clientDeps])

  // Mount-time silent bootstrap (Phase 7 GATE 2, un-drops Task 2): a cold
  // browser reload has already lost the in-memory access token (tokenStore is
  // a plain module closure, never persisted), so without this the operator
  // would be bounced to the login page on every reload even though the
  // HttpOnly refresh cookie is still valid. This fires a SINGLE cookie-only
  // POST /session/rehydrate (never /session/refresh, which requires the
  // in-memory bearer this cold start does not have) and, on success, sets the
  // access token + principal exactly as login() does, without a login call.
  // Any failure (non-2xx, a thrown network error, or a malformed/missing
  // token) falls through cleanly to the unauthenticated state; there is no
  // retry.
  //
  // Ref-alone, NOT the repo's cancelled-flag "house pattern": /session/
  // rehydrate ROTATES a one-time-use refresh token with reuse detection
  // (services/auth/src/refresh.ts), it is not an idempotent read. Under React
  // 18 StrictMode (dev only, main.tsx), an effect runs setup1 -> cleanup1 ->
  // setup2. A cancelled-flag cleanup would only suppress applying setup1's
  // result; it would NOT stop setup2 from firing a second /session/rehydrate
  // presenting the SAME refresh cookie, which rotateRefresh treats as reuse
  // and revokes the entire family, logging the user out. The ref is set to
  // true synchronously before any async work, so setup2 sees it already true
  // and never fires at all: exactly one call, full stop, and its 2xx result
  // is applied (not discarded). A genuine remount (a fresh provider instance)
  // gets a fresh ref and correctly re-attempts. The theoretical post-unmount
  // setState warning is accepted: the root AuthProvider never unmounts in
  // practice, and a cancelled flag here is unsafe, not merely unnecessary.
  //
  // P-C ADDENDUM. That last sentence stopped being true once this effect had to
  // settle `bootstrapping`. In a TEST the provider genuinely does unmount, and
  // the settle then ran against a torn-down jsdom, throwing
  // "ReferenceError: window is not defined" from React's scheduler. It failed
  // the whole run while every test still reported green.
  //
  // The fix is an unmounted flag on the SETTLE ONLY, never on the request. The
  // request must still fire exactly once (reuse detection), so `unmountedRef`
  // deliberately does NOT gate `rehydrateAttempted`. It is cleared on every
  // setup, so StrictMode's setup1 -> cleanup1 -> setup2 leaves it false and
  // setup1's in-flight result still settles, which is the whole point of the
  // ref-alone pattern above.
  const rehydrateAttempted = useRef(false)
  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    if (rehydrateAttempted.current) return () => { unmountedRef.current = true }
    rehydrateAttempted.current = true
    // Guards the (currently impossible within one provider lifecycle, but
    // cheap to check) case of an access token already present in memory: a
    // rehydrate would be redundant and could only ever downgrade the session.
    if (getAccessToken() !== null) {
      setBootstrapping(false)
      return () => { unmountedRef.current = true }
    }

    void (async () => {
      try {
        const res = await sendOnce(clientDeps, { method: 'POST', path: '/session/rehydrate', base: 'auth', withCookie: true })
        if (res.status < 200 || res.status >= 300) return
        const tok = (res.data as { accessToken?: string }).accessToken
        if (typeof tok !== 'string') return
        const claims = decodeTokenClaims(tok)
        setAccessToken(tok)
        setPrincipal(claims)
      } catch {
        // No cookie, reuse/revoke/idle/absolute expiry, a network failure, or
        // a malformed token: fall through to unauthenticated, single attempt.
      } finally {
        // ALWAYS settles on every exit path, success or failure: a bootstrapping
        // flag that can stick on would hang the app on a blank screen instead of
        // showing the login page. Skipped only when the provider is already
        // gone, where there is no state left to set and React's scheduler would
        // reach for a `window` the test environment has torn down.
        if (!unmountedRef.current) setBootstrapping(false)
      }
    })()

    return () => { unmountedRef.current = true }
  }, [])

  // The explicit return type is load-bearing: without it useCallback infers
  // `boolean` for the discriminant and the union no longer narrows.
  const login = useCallback(async (body: { handle: string; password: string; totp: string }): Promise<LoginOutcome> => {
    const res = await loginEndpoint(client, body)
    // Decode BEFORE storing anything: a malformed token throws here and the
    // caller (LoginPage) surfaces it as a failed login, with no token and no
    // principal ever set.
    // "Keep going" answers carry no token at all: nothing to decode, nothing to
    // store, and the principal stays null so RequireAuth keeps the app locked.
    if (res.mfaRequired === true || res.accessToken === undefined) {
      return { kind: 'mfa-required' }
    }
    const claims = decodeTokenClaims(res.accessToken)
    setAccessToken(res.accessToken)
    if (res.enrollmentRequired === true) {
      // Deliberately do NOT set the principal: an enrollment token is not a
      // session. The token is stored only so the enrollment request can carry
      // it, and it authorizes exactly one operation, so nothing else becomes
      // reachable.
      return { kind: 'enrollment-required', principalId: claims.sub }
    }
    setPrincipal(claims)
    return { kind: 'session' }
  }, [client])

  const logout = useCallback(async () => {
    try {
      await logoutEndpoint(client)
    } finally {
      clearAccessToken()
      setPrincipal(null)
    }
  }, [client])

  const value = useMemo<AuthContextValue>(
    () => ({ principal, bootstrapping, client, login, logout }),
    [principal, bootstrapping, client, login, logout],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
      <StepUpDialog />
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
