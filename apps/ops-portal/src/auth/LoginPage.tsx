import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext.js'
import { ApiError } from '../api/errors.js'
import { Button, Field, Input, ErrorNote } from '../ui/primitives.js'
import { IconShield } from '../ui/icons.js'

// Demo skin login (Task 4) over the UNCHANGED auth spine. The field labels
// (Username / Password / TOTP), the submit label (Sign in), and the role=alert
// error surface are preserved exactly so the spine's auth flow and its tests
// are untouched; only the presentation is new.
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
      // Labelled "Username" for the operator; the wire contract names it `handle`.
      await login({ handle, password, totp })
    } catch (err) {
      // Uniform failure: the edge never reveals which factor failed.
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
    <div className="flex min-h-screen bg-bg">
      {/* Brand panel (md+). The lifecycle line echoes the console's signature. */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-brand p-12 text-brand-contrast lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/15">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 17 12 5l6 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M8.5 13h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-lg font-semibold">AndPayments Ops Console</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-[-0.01em]">
            The operations cockpit for soundbox dispatch.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-white/75">
            Track every device from bank request to activation, resolve exceptions, and act with
            an auditable, step-up-gated trail.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-2 text-[12px] font-medium text-white/80">
            {['Received', 'Pooled', 'Sent', 'Dispatched', 'Delivered', 'Activated'].map((s, i, arr) => (
              <span key={s} className="flex items-center gap-2">
                <span className="rounded-full bg-white/12 px-2.5 py-1">{s}</span>
                {i < arr.length - 1 && <span className="text-white/40">›</span>}
              </span>
            ))}
          </div>
        </div>
        <p className="text-[12px] text-white/55">Class-3 human plane · AAL2 · in-memory tokens</p>
      </div>

      {/* Form card. */}
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="text-lg font-semibold text-ink">AndPayments</span>
          </div>
          <div className="mb-1 flex items-center gap-2 text-brand">
            <IconShield width={18} height={18} />
            <span className="text-[12px] font-semibold uppercase tracking-wide">Secure sign in</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">Sign in</h1>
          <p className="mt-1.5 text-sm text-muted">Use your operator credentials and authenticator code.</p>

          <form className="mt-7 space-y-4" onSubmit={(e) => { void onSubmit(e) }}>
            <Field label="Username" htmlFor="login-handle">
              <Input
                id="login-handle"
                name="username"
                autoComplete="username"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
              />
            </Field>
            <Field label="Password" htmlFor="login-password">
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="TOTP" htmlFor="login-totp" hint="6-digit code from your authenticator app.">
              <Input
                id="login-totp"
                name="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="num tracking-[0.3em]"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
              />
            </Field>
            {error !== null && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" loading={submitting} className="w-full">
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
