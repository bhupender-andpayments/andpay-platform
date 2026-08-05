import { useState, useSyncExternalStore } from 'react'
import { cancelStepUp, confirmStepUp, getStepUpOpen, subscribeStepUp } from './stepUpController.js'
import { Button, Field, Input } from '../ui/primitives.js'
import { IconShield } from '../ui/icons.js'

// Task 8 (check 2) built the spine: the modal counterpart to the reactive 403
// step-up interceptor in `../api/client.ts` (Task 6). It renders only while
// the stepUpController singleton says a prompt is pending, so it can sit once
// in the provider tree (AuthContext) and serve any number of imperative
// promptStepUpTotp() calls.
//
// Task 12: presentation-only reskin onto the Task 1 ui/* design system.
// SPINE_FILE: only className/markup changed here. The contract every caller
// depends on is byte-identical to before: role="dialog" + aria-modal +
// aria-label="Step-up authentication", the TOTP field's id/name/label
// ("stepup-totp"/"TOTP"), the Confirm/Cancel button names, and the
// resolve-once-then-clear semantics (the entered code is never retained past
// the single resolve() call). `stepUpController.ts` is untouched.
export function StepUpDialog() {
  const open = useSyncExternalStore(subscribeStepUp, getStepUpOpen, getStepUpOpen)
  const [code, setCode] = useState('')

  if (!open) return null

  function onConfirm() {
    const submitted = code
    // Discard immediately: the code must not be retained anywhere queryable
    // once it has been handed to the caller's promise.
    setCode('')
    confirmStepUp(submitted)
  }

  function onCancel() {
    setCode('')
    cancelStepUp()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Step-up authentication"
        className="relative w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-lg"
      >
        <div className="mb-1 flex items-center gap-2 text-brand">
          <IconShield width={18} height={18} />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Step-up required</span>
        </div>
        <h2 className="text-lg font-semibold text-ink">Confirm your identity</h2>
        <p className="mt-1 text-[13px] text-muted">
          Enter your current authentication code to continue.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onConfirm()
          }}
        >
          <Field label="TOTP" htmlFor="stepup-totp">
            <Input
              id="stepup-totp"
              name="stepup-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              className="num text-center text-lg tracking-[0.4em]"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">Confirm</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
