import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { holdRecord } from '../../api/endpoints.js'

// Record hold (spec 13 task 14, check 6). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts's hold, grounded against
// services/fulfillment/src/ops.ts's holdRecord): posts to
// /ops/records/:asgnId/hold with NO body, only a fresh Idempotency-Key, NOT
// step-up-gated (`ops:record-hold` is absent from
// OPS_STEP_UP_GATED_OPERATIONS). Its counterpart release IS step-up-gated
// (`ops:record-release` / 'hold-release') and belongs to Task 15; it is
// deliberately not built here.
export function HoldButton() {
  const { client } = useAuth()
  const [asgnId, setAsgnId] = useState('')
  const [result, setResult] = useState<{ deduped: boolean } | null>(null)
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
      const res = await holdRecord(client, asgnId, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to place the hold.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-800">Hold record</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="hold-asgnId">
            Assignment ID
          </label>
          <input
            id="hold-asgnId"
            value={asgnId}
            onChange={(e) => setAsgnId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          Hold
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-slate-800">
          {result.deduped ? 'Already held (deduped). ' : 'Hold recorded.'}
        </p>
      )}
    </div>
  )
}
