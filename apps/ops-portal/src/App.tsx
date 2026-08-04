import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.js'
import { AppRoutes } from './routes.js'

// Demo skin app root: the spine's AuthProvider wraps a real BrowserRouter over
// the router-agnostic route tree. The persistent frame now lives inside the
// authenticated Shell (src/ui/AppShell.tsx); the login route renders full-bleed
// with its own brand wordmark, so there is no always-on header here.
export function App() {
  return (
    <AuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}
