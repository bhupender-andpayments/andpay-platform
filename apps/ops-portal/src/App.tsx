import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.js'
import { AppRoutes } from './routes.js'

// The real app shell (spec 13 task 9): AuthProvider (spec 13 task 7) wraps a
// real BrowserRouter over the router-agnostic route tree in routes.tsx. The
// header stays outside RequireAuth/the router so it renders on every route,
// unauthenticated or not (it also keeps the original Task-2 smoke test,
// which renders <App/> with no route or auth setup, passing unchanged).
export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="flex min-h-screen flex-col bg-white">
          <header className="border-b border-slate-200 px-4 py-3">
            <h1 className="text-lg font-semibold text-slate-900">AndPayments Ops</h1>
          </header>
          <AppRoutes />
        </div>
      </BrowserRouter>
    </AuthProvider>
  )
}
