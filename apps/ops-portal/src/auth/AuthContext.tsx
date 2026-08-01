import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createApiClient } from '../api/client.js'
import { setAccessToken, clearAccessToken } from '../api/tokenStore.js'
import { login as loginEndpoint, logout as logoutEndpoint } from '../api/endpoints.js'
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
  // Exposed so feature pages (Task 10's dashboards, and the tasks after it)
  // can call the typed endpoint functions under the same interceptor pipeline
  // (401 refresh, 403 step-up) the login/logout calls already use, rather
  // than each page constructing its own client with divergent deps.
  client: ReturnType<typeof createApiClient>
  login(body: { handle: string; password: string; totp: string }): Promise<void>
  logout(): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)

  // An unrecoverable session loss (both refresh attempts exhausted): drop the
  // display principal so the app falls back to the login page.
  const onSessionLost = useCallback(() => { setPrincipal(null) }, [])

  const client = useMemo(() => createApiClient({
    opsBase: (import.meta.env.VITE_OPS_BASE as string | undefined) ?? 'http://localhost:3001',
    authBase: (import.meta.env.VITE_AUTH_BASE as string | undefined) ?? 'http://localhost:3000',
    onSessionLost,
    promptStepUpTotp,
  }), [onSessionLost, promptStepUpTotp])

  const login = useCallback(async (body: { handle: string; password: string; totp: string }) => {
    const res = await loginEndpoint(client, body)
    // Decode BEFORE storing anything: a malformed token throws here and the
    // caller (LoginPage) surfaces it as a failed login, with no token and no
    // principal ever set.
    const claims = decodeTokenClaims(res.accessToken)
    setAccessToken(res.accessToken)
    setPrincipal(claims)
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
    () => ({ principal, client, login, logout }),
    [principal, client, login, logout],
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
