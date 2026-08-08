import type { ReactNode } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.js'

// A CLIENT-SIDE CONVENIENCE gate only, never an authorization decision (S24/
// T14). It redirects to /login when there is no display principal, purely so
// the SPA does not render a feature screen over an empty session. It grants
// no access: every ops-edge/auth-edge call still carries the Bearer token
// and the edge independently re-verifies and re-authorizes every request. A
// user could bypass this component entirely and every call would still be
// decided solely by the edge.
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { principal, bootstrapping } = useAuth()
  // P-C: WAIT, do not redirect, while the mount-time rehydrate is still in
  // flight. On a cold load the access token is gone and the rehydrate is async,
  // so redirecting here on the first tick threw away the operator's
  // destination: they asked for /batches/xyz and landed on the dashboard once
  // the session came back. Rendering nothing keeps the router where it is, so
  // the intended route simply renders when the principal arrives.
  //
  // Deliberately renders nothing rather than a spinner: the wait is one
  // round-trip on a local network, and a flashed spinner reads worse than a
  // brief blank. This is still no authorization decision (S24/T14).
  if (bootstrapping) return null
  if (principal === null) return <Navigate to="/login" replace />
  return children !== undefined ? <>{children}</> : <Outlet />
}
