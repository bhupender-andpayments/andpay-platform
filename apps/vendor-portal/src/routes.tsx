import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.js'
import { LoginPage } from './auth/LoginPage.js'
import { Nav } from './components/Nav.js'
import { RequireAuth } from './components/RequireAuth.js'
import { WorkQueuePage } from './features/workqueue/WorkQueuePage.js'
import { HistoryPage } from './features/history/HistoryPage.js'
import { ReturnUploadPage } from './features/returns/ReturnUploadPage.js'

// Router-agnostic route tree (no <BrowserRouter> here) so tests can wrap it
// in a <MemoryRouter> with a chosen initialEntries, mirroring
// apps/ops-portal/src/routes.tsx. App.tsx supplies the real <BrowserRouter>
// for the running app.

// The login route redirects away from itself once a principal already
// exists, the mirror image of RequireAuth. Neither side is an authorization
// decision: both only steer navigation over a display-only principal.
function LoginRoute() {
  const { principal } = useAuth()
  if (principal !== null) return <Navigate to="/" replace />
  return <LoginPage />
}

// The authenticated shell: the left Nav plus whatever feature route matched.
function Shell() {
  return (
    <div className="flex flex-1">
      <Nav />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route path="/" element={<WorkQueuePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/returns" element={<ReturnUploadPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
