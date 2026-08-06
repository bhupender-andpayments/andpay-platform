import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useAuth } from './AuthContext.js'
import { enrollSelf, confirmEnrollment } from '../api/endpoints.js'
import { Button, ErrorNote, InfoNote, Field, Input } from '../ui/primitives.js'

// First-login TOTP setup. Reached only when /session/login answered
// enrollmentRequired, which means the operator authenticated by password and
// holds no factor yet. The token in play authorizes exactly one operation
// (mfa:enroll, own principal only), so nothing else in the app is reachable
// from here.
//
// The otpauth:// URI is returned ONCE by the edge. It is therefore requested
// exactly once, held in component state, and never refetched: a remount would
// rotate the secret and silently invalidate whatever the operator just scanned.
// The QR is rendered client-side from that URI; no image is ever generated
// server-side and the secret never reaches a log or a URL.

interface Props {
  principalId: string
  accountLabel: string
  onDone: () => void
}

export function EnrollTotpPanel({ principalId, accountLabel, onDone }: Props) {
  const { client } = useAuth()
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSecret, setShowSecret] = useState(false)
  const [code, setCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)

  // Proves possession of the secret. Until this succeeds the enrollment is
  // PENDING and the account has no factor, so abandoning this screen is safe.
  async function onConfirm(): Promise<void> {
    setConfirmError(null)
    if (code.trim().length === 0) {
      setConfirmError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setConfirming(true)
    try {
      await confirmEnrollment(client, { totp: code.trim() })
      onDone()
    } catch {
      // The most common cause is a code read from a STALE entry: every visit to
      // this screen issues a new secret under the same label, so an app that
      // has scanned before shows several identical-looking AndPayments entries
      // and only the newest one works. Saying so is the difference between a
      // dead end and a fix the operator can apply.
      setConfirmError(
        'That code did not match. If your authenticator shows more than one AndPayments entry, delete them all, scan the code above again, then enter the new code.',
      )
      setCode('')
    } finally {
      setConfirming(false)
    }
  }
  // Guards against React 18 StrictMode's intentional double-effect in
  // development. Without it the second run would mint a SECOND secret and the
  // QR the operator is looking at would already be revoked.
  const requested = useRef(false)

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    void (async () => {
      try {
        const res = await enrollSelf(client, {
          targetPrincipalId: principalId,
          targetAccountLabel: accountLabel,
        })
        setOtpauthUri(res.otpauthUri)
        setQrDataUrl(
          await QRCode.toDataURL(res.otpauthUri, { width: 224, margin: 1, errorCorrectionLevel: 'M' }),
        )
      } catch {
        setError('Could not start authenticator setup. Sign in again to retry.')
      }
    })()
  }, [client, principalId, accountLabel])

  // The base32 secret carried in the URI, for operators who cannot scan a code.
  const manualKey = otpauthUri === null ? null : new URL(otpauthUri).searchParams.get('secret')

  return (
    <>
      <h1 className="mt-1 text-3xl font-bold tracking-[-0.02em] text-ink">Set up your authenticator</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Your account has no authenticator yet. Scan this code with an authenticator app, then sign in with the
        6-digit code it shows.
      </p>

      {error !== null && <div className="mt-5">{<ErrorNote>{error}</ErrorNote>}</div>}

      {error === null && (
        <div className="mt-6 space-y-5">
          <div className="flex justify-center rounded-lg border border-line bg-surface p-5">
            {qrDataUrl === null ? (
              <div className="skeleton h-[224px] w-[224px]" aria-label="Preparing your setup code" />
            ) : (
              <img src={qrDataUrl} alt="Authenticator setup QR code" width={224} height={224} />
            )}
          </div>

          {manualKey !== null && (
            <div>
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="text-[13px] font-medium text-brand hover:text-brand-strong"
              >
                {showSecret ? 'Hide setup key' : 'Cannot scan? Enter a key instead'}
              </button>
              {showSecret && (
                <p className="num mt-2 select-all break-all rounded border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink">
                  {manualKey}
                </p>
              )}
            </div>
          )}

          <InfoNote>
            Nothing is saved until you enter a code below, so it is safe to start over if you lose this screen.
          </InfoNote>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void onConfirm()
            }}
          >
            <Field label="Confirmation code" htmlFor="enroll-totp" hint="Enter the 6-digit code your app now shows.">
              <Input
                id="enroll-totp"
                name="enrollTotp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                className="num h-14 text-center text-2xl tracking-[0.5em] placeholder:text-line-strong"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            {confirmError !== null && <ErrorNote>{confirmError}</ErrorNote>}
            <Button
              type="submit"
              loading={confirming}
              className="h-12 w-full rounded-full text-[15px]"
              disabled={qrDataUrl === null}
            >
              Confirm and continue
            </Button>
          </form>
        </div>
      )}
    </>
  )
}
