import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { suspendVendor } from '../../api/endpoints.js'

// Vendor suspend (spec 13 task 15, checks 2 and 3). The confirmed ops-edge
// contract (apps/ops-edge/src/ops.controller.ts's suspend): posts to
// /ops/vendors/:id/suspend with NO body, only a fresh Idempotency-Key AND
// the 'vendor-suspend' stepUpKey. The read-only vendor registry
// (../masterdata/VendorRegistryPage.tsx, Task 12) deliberately did not
// build this action; it lives here as its own standalone control (YAGNI:
// exactly the three destructive actions, no row-level wiring).
//
// This component makes NO authorization decision (S24/T14): it does not
// re-implement step-up, and it renders enabled regardless of any
// client-side notion of permission, because the display principal carries
// no permission claim to gate on. Even a persistently-denying edge (a 403
// both before and after step-up) is surfaced here, never silently granted.
export function VendorSuspendButton() {
  const { client } = useAuth()
  const [vendorId, setVendorId] = useState('')
  const [result, setResult] = useState<{ deduped: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setResult(null)
    if (vendorId.trim() === '') {
      setError('Vendor ID is required.')
      return
    }
    setBusy(true)
    try {
      const res = await suspendVendor(client, vendorId, newIdempotencyKey())
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to suspend the vendor.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded border border-red-200 p-4">
      <h2 className="text-sm font-semibold text-slate-800">Suspend vendor</h2>
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="suspend-vendorId">
            Vendor ID
          </label>
          <input
            id="suspend-vendorId"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-40"
        >
          Suspend
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {result !== null && (
        <p className="text-sm text-slate-800">
          {result.deduped ? 'Already suspended (deduped). ' : 'Suspended.'}
        </p>
      )}
    </div>
  )
}
