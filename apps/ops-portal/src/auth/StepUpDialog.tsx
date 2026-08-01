import { useState, useSyncExternalStore } from 'react'
import { cancelStepUp, confirmStepUp, getStepUpOpen, subscribeStepUp } from './stepUpController.js'

// Task 8 (check 2): the modal counterpart to the reactive 403 step-up
// interceptor in `../api/client.ts` (Task 6). It renders only while the
// stepUpController singleton says a prompt is pending, so it can sit once in
// the provider tree (AuthContext) and serve any number of imperative
// promptStepUpTotp() calls.
//
// YAGNI (per task brief): a labelled TOTP input plus Confirm/Cancel. No
// retry counter, no timers, no styling beyond what's needed to be findable.
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
    <div role="dialog" aria-modal="true" aria-label="Step-up authentication">
      <h2>Confirm your identity</h2>
      <p>Enter your current authentication code to continue.</p>
      <div>
        <label htmlFor="stepup-totp">TOTP</label>
        <input
          id="stepup-totp"
          name="stepup-totp"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <button type="button" onClick={onConfirm}>Confirm</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  )
}
