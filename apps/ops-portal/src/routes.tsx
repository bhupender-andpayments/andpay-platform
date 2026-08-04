import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.js'
import { LoginPage } from './auth/LoginPage.js'
import { RequireAuth } from './components/RequireAuth.js'
import { AppShell } from './ui/AppShell.js'
import { TilesPage } from './features/dashboards/TilesPage.js'
import { ReportPage } from './features/dashboards/ReportPage.js'
import { QueuesPage } from './features/queues/QueuesPage.js'
import { MasterDataPage } from './features/masterdata/MasterDataPage.js'
import { UploadsPage } from './features/uploads/UploadsPage.js'
import { OperationsPage } from './features/operations/OperationsPage.js'

// Router-agnostic route tree (no <BrowserRouter> here) so tests can wrap it
// in a <MemoryRouter> with a chosen initialEntries, per Task 9's test plan.
// App.tsx supplies the real <BrowserRouter> for the running app.

// The login route redirects away from itself once a principal already
// exists, the mirror image of RequireAuth. Neither side is an authorization
// decision: both only steer navigation over a display-only principal.
function LoginRoute() {
  const { principal } = useAuth()
  if (principal !== null) return <Navigate to="/dashboards" replace />
  return <LoginPage />
}

// The authenticated shell: the branded sidebar + top bar frame around whatever
// feature route matched.
function Shell() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route path="/dashboards" element={<TilesPage />} />
          <Route path="/reports" element={<ReportPage />} />
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/masterdata" element={<MasterDataPage />} />
          <Route path="/uploads" element={<UploadsPage />} />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/" element={<Navigate to="/dashboards" replace />} />
          <Route path="*" element={<Navigate to="/dashboards" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
