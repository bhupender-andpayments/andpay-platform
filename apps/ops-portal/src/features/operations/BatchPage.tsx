import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { triggerBatch } from '../../api/endpoints.js'

// Manual batch trigger (spec 13 task 14, check 6). The confirmed ops-edge
// contract (apps/ops-edge/src/ops.controller.ts's batchTrigger, grounded
// against services/fulfillment/src/batching.ts's manualBatch): posts
// { tenantWire, programWire } with a fresh Idempotency-Key, NOT step-up-gated
// (`ops:manual-batch-trigger` is absent from OPS_STEP_UP_GATED_OPERATIONS).
// The response is `{ btchId } | null`: null means there was nothing eligible
// to batch, a real outcome (not an error), and is rendered as a plain
// message rather than treated as a failure.
export function BatchPage() {
  const { client } = useAuth()
  const [tenantWire, setTenantWire] = useState('')
  const [programWire, setProgramWire] = useState('')
  const [result, setResult] = useState<{ btchId: string } | null>(null)
  const [hasResult, setHasResult] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setHasResult(false)
    setBusy(true)
    try {
      const res = await triggerBatch(client, { tenantWire, programWire }, newIdempotencyKey())
      setResult(res)
      setHasResult(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger the batch.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-ink">Trigger batch</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="batch-tenantWire">
            Tenant
          </label>
          <input
            id="batch-tenantWire"
            value={tenantWire}
            onChange={(e) => setTenantWire(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="batch-programWire">
            Program
          </label>
          <input
            id="batch-programWire"
            value={programWire}
            onChange={(e) => setProgramWire(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-brand px-4 text-sm font-medium text-brand-contrast shadow-sm hover:bg-brand-strong disabled:opacity-40"
        >
          Trigger
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
          {error}
        </p>
      )}

      {hasResult &&
        (result === null ? (
          <p className="text-[13px] text-muted">Nothing to batch.</p>
        ) : (
          <p className="text-sm text-ink">
            Batch triggered: <span className="font-mono">{result.btchId}</span>
          </p>
        ))}
    </div>
  )
}
