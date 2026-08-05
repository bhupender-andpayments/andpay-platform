import { useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext.js'
import { ApiError } from '../api/errors.js'
import { Button, Card, Field, Input, ErrorNote } from '../ui/primitives.js'
import { IconShield, IconChevron } from '../ui/icons.js'

// Task 12: presentation-only reskin over the UNCHANGED auth spine, onto the
// Task 1 ui/* design system. Two visual steps (credentials, then TOTP), but
// both factors are still submitted together in a SINGLE spine login() call
// at final submit, exactly as before: the step split is a client-side gate
// on when the TOTP field is revealed, not a second network round trip or a
// server-side "password valid?" probe, so the edge's uniform-failure
// property (never revealing which factor failed) is unchanged. Field
// ids/names/labels (Username, Password, TOTP, Sign in) and the role=alert
// error surface are the same as before, so nothing downstream of
// AuthContext.login() changes.
//
// Brand mark: a Task-3 review carry-forward. Task 1's AppShell port dropped
// the old always-on header, so the (unauthenticated) login screen otherwise
// has no branding at all. This is a plain text wordmark styled with the
// design tokens, consistent with AppShell's BrandMark; no logo asset is
// invented.
function BrandMark() {
  return (
    <div className="mb-8 flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-brand-contrast shadow-sm">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 17 12 5l6 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.5 13h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-ink">AndPayments</span>
        <span className="block text-[11px] font-medium uppercase tracking-wide text-subtle">Ops Console</span>
      </span>
    </div>
  )
}

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
      // The field is labelled "Username" for the ops user, but the wire
      // contract (auth-edge login.controller.ts) names it `handle`. Both
      // factors go out together in this ONE call, regardless of how many
      // screens the operator saw first.
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
      setTotp('')
      setStep('credentials')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main aria-label="Sign in" className="flex min-h-screen items-center justify-center bg-bg px-6 py-12">
      <div className="w-full max-w-sm">
        <BrandMark />
        <Card className="p-7">
          <div className="mb-1 flex items-center gap-2 text-brand">
            <IconShield width={18} height={18} />
            <span className="text-[12px] font-semibold uppercase tracking-wide">Secure sign in</span>
          </div>

          {step === 'credentials' ? (
            <>
              <h1 className="text-2xl font-semibold tracking-[-0.01em] text-ink">Sign in</h1>
              <p className="mt-1.5 text-sm text-muted">Enter your operator credentials to continue.</p>
              <form className="mt-6 space-y-4" onSubmit={onContinue}>
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
                Signing in as <span className="font-medium text-ink">{handle}</span>. Enter the 6-digit code from
                your authenticator app.
              </p>
              <form className="mt-6 space-y-4" onSubmit={(e) => { void onSubmit(e) }}>
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
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setError(null)
                    setStep('credentials')
                  }}
                >
                  Back
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </main>
  )
}
