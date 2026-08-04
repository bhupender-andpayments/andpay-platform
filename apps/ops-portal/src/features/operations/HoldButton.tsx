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
    <div className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">Hold record</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="hold-asgnId">
            Assignment ID
          </label>
          <input
            id="hold-asgnId"
            value={asgnId}
            onChange={(e) => setAsgnId(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-brand px-4 text-sm font-medium text-brand-contrast shadow-sm hover:bg-brand-strong disabled:opacity-40"
        >
          Hold
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-ink">
          {result.deduped ? 'Already held (deduped). ' : 'Hold recorded.'}
        </p>
      )}
    </div>
  )
}
