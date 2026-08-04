import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { overrideTerminal } from '../../api/endpoints.js'

// Terminal override (spec 13 task 15, checks 2 and 3). The confirmed
// ops-edge contract (apps/ops-edge/src/ops.controller.ts's override):
// posts { status, courierTimestamp, overrideReason } to
// /ops/shipments/:id/override with a fresh Idempotency-Key AND the
// 'terminal-override' stepUpKey, so a 403 drives the real TOTP dialog
// (../../auth/StepUpDialog.tsx via ../../api/client.ts's interceptor) and
// retries ONCE with the SAME idempotency key.
//
// The status dropdown reuses Task 14's exact KNOWN_STATUSES set
// (../operations/StatusCorrectionForm.tsx), the set the edge's
// isKnownStatus() accepts. overrideReason is free text and required.
//
// This component makes NO authorization decision (S24/T14): it does not
// re-implement step-up (the client + dialog already handle it) and it does
// not gate itself on any client-side notion of scope, because the display
// principal (useAuth().principal) carries no permission claim to gate on.
// The edge is the sole authority and re-checks on every call, regardless of
// whether this control renders enabled or disabled.
const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

export function TerminalOverrideForm() {
  const { client } = useAuth()
  const [shptId, setShptId] = useState('')
  const [status, setStatus] = useState<string>(KNOWN_STATUSES[0])
  const [courierTimestamp, setCourierTimestamp] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [result, setResult] = useState<{ deduped: boolean; overridden: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (shptId.trim() === '' || courierTimestamp.trim() === '' || overrideReason.trim() === '') {
      setError('Shipment ID, courier timestamp, and override reason are all required.')
      return
    }
    setBusy(true)
    try {
      const res = await overrideTerminal(client, shptId, { status, courierTimestamp, overrideReason }, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the terminal override.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded border border-red-200 p-4">
      <h2 className="text-sm font-semibold text-ink">Terminal override</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="override-shptId">
            Shipment ID
          </label>
          <input
            id="override-shptId"
            value={shptId}
            onChange={(e) => setShptId(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="override-status">
            Status
          </label>
          <select
            id="override-status"
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
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="override-courierTimestamp">
            Courier timestamp
          </label>
          <input
            id="override-courierTimestamp"
            value={courierTimestamp}
            onChange={(e) => setCourierTimestamp(e.target.value)}
            placeholder="2026-08-01T10:00"
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="override-reason">
            Override reason
          </label>
          <input
            id="override-reason"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-[#b91c1c] px-4 text-sm font-medium text-white shadow-sm hover:bg-[#a11616] disabled:opacity-40"
        >
          Override
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
          {result.overridden ? 'Overridden.' : 'Not overridden.'}
        </p>
      )}
    </div>
  )
}
