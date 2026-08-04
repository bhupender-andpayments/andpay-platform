import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { correctStatus } from '../../api/endpoints.js'

// Status correction (spec 13 task 14, check 6). The confirmed ops-edge
// contract (apps/ops-edge/src/ops.controller.ts's correct, grounded against
// services/fulfillment/src/courier-status.ts): posts
// { status, courierTimestamp } to /ops/shipments/:id/correct with a fresh
// Idempotency-Key, NOT step-up-gated (`ops:status-correction` is absent from
// OPS_STEP_UP_GATED_OPERATIONS; the step-up-gated terminal override is Task
// 15's separate route).
//
// The status dropdown is grounded in courier-status.ts's KNOWN_STATUS set
// (Object.keys(LADDER_RANK) plus the two off-ladder terminal-ish settles),
// the exact set the edge's isKnownStatus() accepts, rather than a free-text
// field a caller could send an unknown status through.
const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

export function StatusCorrectionForm() {
  const { client } = useAuth()
  const [shptId, setShptId] = useState('')
  const [status, setStatus] = useState<string>(KNOWN_STATUSES[0])
  const [courierTimestamp, setCourierTimestamp] = useState('')
  const [result, setResult] = useState<{ deduped: boolean; outcome: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (shptId.trim() === '' || courierTimestamp.trim() === '') {
      setError('Shipment ID and courier timestamp are both required.')
      return
    }
    setBusy(true)
    try {
      const res = await correctStatus(client, shptId, { status, courierTimestamp }, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the status correction.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">Status correction</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="correct-shptId">
            Shipment ID
          </label>
          <input
            id="correct-shptId"
            value={shptId}
            onChange={(e) => setShptId(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="correct-status">
            Status
          </label>
          <select
            id="correct-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          >
            {KNOWN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="correct-courierTimestamp">
            Courier timestamp
          </label>
          <input
            id="correct-courierTimestamp"
            value={courierTimestamp}
            onChange={(e) => setCourierTimestamp(e.target.value)}
            placeholder="2026-08-01T10:00"
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-brand px-4 text-sm font-medium text-brand-contrast shadow-sm hover:bg-brand-strong disabled:opacity-40"
        >
          Submit correction
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-ink">
          {result.deduped ? 'Already applied (deduped). ' : ''}
          Outcome: <span className="font-mono">{result.outcome ?? 'none'}</span>
        </p>
      )}
    </div>
  )
}
