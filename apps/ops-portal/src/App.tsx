import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.js'
import { ToastProvider } from './ui/Toast.js'
import { AppRoutes } from './routes.js'

// The real app shell (Phase 7 task 3): AuthProvider wraps a real
// BrowserRouter over the router-agnostic route tree in routes.tsx. The
// branded frame now lives entirely inside the authenticated Shell
// (src/ui/AppShell.tsx, routes.tsx); the login route renders full-bleed with
// its own form, so there is no always-on header here. This matches the
// demo's composition (demo/ops-portal-skin App.tsx) and the AppShell brand
// mark (Sidebar's "AndPayments" / "Ops Console") is now the single source of
// branding, not a second header stacked above it.
export function App() {
  return (
    <AuthProvider>
      {/* Outside the router so a toast survives the navigation that caused it:
          committing on one step and landing on the next must not swallow the
          message about what the commit did. */}
      <ToastProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}
