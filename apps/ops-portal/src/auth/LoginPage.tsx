import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext.js'
import { ApiError } from '../api/errors.js'
import { Button, Field, Input, ErrorNote } from '../ui/primitives.js'
import { IconShield, IconChevron } from '../ui/icons.js'

// Demo skin login (Task 4) over the UNCHANGED auth spine. Two steps: username +
// password first, then the authenticator code on a second screen. Both factors
// are still submitted together in the single spine login() call, so the edge's
// uniform-failure property is preserved (a true server-side "password valid?"
// probe before the TOTP step would need a new endpoint and would weaken that
// anti-enumeration guarantee, so it is deliberately not done here). The field
// labels (Username / Password / TOTP), the final submit label (Sign in), and
// the role=alert error surface are preserved so the spine's flow is untouched.

const BrandPanel = () => (
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
        Track every device from bank request to activation, resolve exceptions, and act with an
        auditable, step-up-gated trail.
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
)

export function LoginPage() {
  const { login } = useAuth()
  const [step, setStep] = useState<'credentials' | 'totp'>('credentials')
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function onContinue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    if (handle.trim() === '' || password === '') {
      setError('Enter your username and password to continue.')
      return
    }
    setStep('totp')
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login({ handle, password, totp })
    } catch (err) {
      // Uniform failure: the edge never reveals which factor failed. Return to
      // step 1 so the operator can re-enter credentials, and clear the code.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError('Invalid username, password, or authentication code.')
      } else {
        setError('Sign in failed. Please try again.')
      }
      setTotp('')
      setStep('credentials')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <BrandPanel />
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <span className="text-lg font-semibold text-ink">AndPayments</span>
          </div>
          <div className="mb-1 flex items-center gap-2 text-brand">
            <IconShield width={18} height={18} />
            <span className="text-[12px] font-semibold uppercase tracking-wide">Secure sign in</span>
          </div>

          {step === 'credentials' ? (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">Sign in</h1>
              <p className="mt-1.5 text-sm text-muted">Enter your operator credentials to continue.</p>
              <form className="mt-7 space-y-4" onSubmit={onContinue}>
                <Field label="Username" htmlFor="login-handle">
                  <Input
                    id="login-handle"
                    name="username"
                    autoComplete="username"
                    autoFocus
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
                {error !== null && <ErrorNote>{error}</ErrorNote>}
                <Button type="submit" className="w-full">
                  Continue
                  <IconChevron width={16} height={16} />
                </Button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">Two-factor</h1>
              <p className="mt-1.5 text-sm text-muted">
                Signing in as <span className="font-medium text-ink">{handle}</span>. Enter the 6-digit code
                from your authenticator app.
              </p>
              <form className="mt-7 space-y-4" onSubmit={(e) => { void onSubmit(e) }}>
                <Field label="TOTP" htmlFor="login-totp" hint="6-digit code from your authenticator app.">
                  <Input
                    id="login-totp"
                    name="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    className="num text-center text-lg tracking-[0.4em]"
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                  />
                </Field>
                {error !== null && <ErrorNote>{error}</ErrorNote>}
                <Button type="submit" loading={submitting} className="w-full">
                  Sign in
                </Button>
                <button
                  type="button"
                  className="w-full text-center text-[13px] font-medium text-muted hover:text-ink"
                  onClick={() => {
                    setError(null)
                    setStep('credentials')
                  }}
                >
                  Back
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
