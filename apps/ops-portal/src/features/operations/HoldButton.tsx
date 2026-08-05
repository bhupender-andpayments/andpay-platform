import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { holdRecord } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Input, Button, ErrorNote } from '../../ui/primitives.js'

// Record hold (Phase 7 Task 9). The confirmed ops-edge contract
// (apps/ops-edge/src/ops.controller.ts's hold, grounded against
// services/fulfillment/src/ops.ts's holdRecord): posts to
// /ops/records/:asgnId/hold with NO body, only a fresh Idempotency-Key, NOT
// step-up-gated (`ops:record-hold` is absent from
// OPS_STEP_UP_GATED_OPERATIONS). Its counterpart release IS step-up-gated
// (`ops:record-release` / 'hold-release') and lives in the Destructive tab
// (Task 10's scope); it is deliberately not built here.
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
    <Card>
      <CardHeader title="Hold record" subtitle="Place an operational hold on an assignment." />
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3 p-5 pt-4"
      >
        <Field label="Assignment ID" htmlFor="hold-asgnId">
          <Input id="hold-asgnId" value={asgnId} onChange={(e) => setAsgnId(e.target.value)} placeholder="asgn_..." />
        </Field>
        <Button type="submit" disabled={busy} loading={busy}>
          Hold
        </Button>
      </form>

      {error !== null && (
        <div className="px-5 pb-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result !== null && (
        <div className="px-5 pb-5 text-sm text-ink">
          {result.deduped ? 'Already held (deduped). ' : 'Hold recorded.'}
        </div>
      )}
    </Card>
  )
}
