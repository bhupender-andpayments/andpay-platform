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
      <h2 className="text-sm font-semibold text-ink">Release hold</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="release-asgnId">
            Assignment ID
          </label>
          <input
            id="release-asgnId"
            value={asgnId}
            onChange={(e) => setAsgnId(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-[#b91c1c] px-4 text-sm font-medium text-white shadow-sm hover:bg-[#a11616] disabled:opacity-40"
        >
          Release
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-ink">
          {result.deduped ? 'Already released (deduped). ' : ''}
          {result.released ? 'Released.' : 'Not released.'}
        </p>
      )}
    </div>
  )
}
