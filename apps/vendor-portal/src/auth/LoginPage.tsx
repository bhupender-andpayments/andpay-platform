import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext.js'
import { ApiError } from '../api/errors.js'

// YAGNI: login/logout/principal-display only. No self-service enrollment,
// no password reset, no route guard (RequireAuth handles the redirect). No
// step-up: the vendor portal has no destructive actions requiring a
// re-authentication factor beyond the TOTP already required at login.
export function LoginPage() {
  const { login } = useAuth()
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      // The field is labelled "Username" for the vendor operator, but the
      // wire contract (vendor-auth-edge session.controller.ts) names it
      // `handle`.
      await login({ handle, password, totp })
    } catch (err) {
      // A uniform 401 (bad credential, bad TOTP, or unmet assurance floor) or
      // any other failure (a malformed token, a network error) surfaces the
      // same generic message: the edge never reveals which factor failed.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError('Invalid username, password, or authentication code.')
      } else {
        setError('Sign in failed. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={(e) => { void onSubmit(e) }}>
      <h1>Vendor Sign in</h1>
      <div>
        <label htmlFor="login-handle">Username</label>
        <input
          id="login-handle"
          name="username"
          autoComplete="username"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="login-totp">TOTP</label>
        <input
          id="login-totp"
          name="totp"
          autoComplete="one-time-code"
          value={totp}
          onChange={(e) => setTotp(e.target.value)}
        />
      </div>
      {error !== null && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>Sign in</button>
    </form>
  )
}
