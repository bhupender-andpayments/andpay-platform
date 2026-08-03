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
  const { principal } = useAuth()
  if (principal === null) return <Navigate to="/login" replace />
  return children !== undefined ? <>{children}</> : <Outlet />
}
