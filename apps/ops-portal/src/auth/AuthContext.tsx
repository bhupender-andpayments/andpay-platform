import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { createApiClient } from '../api/client.js'
import { setAccessToken, clearAccessToken } from '../api/tokenStore.js'
import { login as loginEndpoint, logout as logoutEndpoint } from '../api/endpoints.js'

// The display-only identity shown in the UI (e.g. "signed in as ..."). It is
// NOT the authorization principal: every request still carries the Bearer
// token and every authz decision is re-checked at the edge (S24/T14).
export interface Principal {
  sub: string
  role?: string
}

// Decodes the middle (payload) segment of a JWT WITHOUT verifying its
// signature. This is DISPLAY-ONLY: the decoded claims are used solely to
// render who is signed in, and are NEVER consulted for any authorization
// decision. The edge is the sole authority and re-verifies the token
// (signature, issuer, audience, mode) on every call (S24/T14). A malformed
// token throws so the caller can treat the login attempt as failed.
export function decodeTokenClaims(token: string): { sub: string; role?: string } {
  const segments = token.split('.')
  const payload = segments[1]
  if (payload === undefined || payload === '') throw new Error('malformed token: missing payload segment')
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const json = atob(padded)
  const claims = JSON.parse(json) as { sub?: unknown; role?: unknown }
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('malformed token: missing sub claim')
  const role = typeof claims.role === 'string' ? claims.role : undefined
  return role === undefined ? { sub: claims.sub } : { sub: claims.sub, role }
}

export interface AuthContextValue {
  principal: Principal | null
  login(body: { handle: string; password: string; totp: string }): Promise<void>
  logout(): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)

  // An unrecoverable session loss (both refresh attempts exhausted): drop the
  // display principal so the app falls back to the login page.
  const onSessionLost = useCallback(() => { setPrincipal(null) }, [])

  // TEMPORARY stub. Task 8 replaces this with the real step-up TOTP dialog
  // (a modal that prompts for the current code and resolves it, or resolves
  // null on cancel). Until then no ops-portal action is step-up gated in a
  // way that reaches this path, so returning null (treated as "cancelled") is
  // safe.
  const promptStepUpTotp = useCallback(async (): Promise<string | null> => null, [])

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

  const value = useMemo<AuthContextValue>(() => ({ principal, login, logout }), [principal, login, logout])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
