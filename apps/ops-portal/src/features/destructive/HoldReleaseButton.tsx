import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { releaseHold } from '../../api/endpoints.js'

// Hold release (spec 13 task 15, checks 2 and 3). The confirmed ops-edge
// contract (apps/ops-edge/src/ops.controller.ts's release): posts to
// /ops/records/:asgnId/release with NO body, only a fresh Idempotency-Key
// AND the 'hold-release' stepUpKey, the counterpart to Task 14's
// non-gated HoldButton (../operations/HoldButton.tsx).
//
// This component makes NO authorization decision (S24/T14): the client
// interceptor and StepUpDialog already own the step-up round trip; this
// just calls the endpoint and shows the result or error. There is no
// client-side scope to gate on (the display principal carries no
// permission claim), so the control renders enabled and relies entirely on
// the edge to be the authority.
export function HoldReleaseButton() {
  const { client } = useAuth()
  const [asgnId, setAsgnId] = useState('')
  const [result, setResult] = useState<{ deduped: boolean; released: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (asgnId.trim() === '') {
      setError('Assignment ID is required.')
      return
    }
    setBusy(true)
    try {
      const res = await releaseHold(client, asgnId, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to release the hold.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded border border-red-200 p-4">
      <h2 className="text-sm font-semibold text-slate-800">Release hold</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="release-asgnId">
            Assignment ID
          </label>
          <input
            id="release-asgnId"
            value={asgnId}
            onChange={(e) => setAsgnId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-40"
        >
          Release
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-slate-800">
          {result.deduped ? 'Already released (deduped). ' : ''}
          {result.released ? 'Released.' : 'Not released.'}
        </p>
      )}
    </div>
  )
}
