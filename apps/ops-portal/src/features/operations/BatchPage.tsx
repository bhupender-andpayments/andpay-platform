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
    <div className="space-y-4 rounded border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-800">Trigger batch</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="batch-tenantWire">
            Tenant
          </label>
          <input
            id="batch-tenantWire"
            value={tenantWire}
            onChange={(e) => setTenantWire(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="batch-programWire">
            Program
          </label>
          <input
            id="batch-programWire"
            value={programWire}
            onChange={(e) => setProgramWire(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          Trigger
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {hasResult &&
        (result === null ? (
          <p className="text-sm text-slate-600">Nothing to batch.</p>
        ) : (
          <p className="text-sm text-slate-800">
            Batch triggered: <span className="font-mono">{result.btchId}</span>
          </p>
        ))}
    </div>
  )
}
