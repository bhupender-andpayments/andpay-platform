import { useState, type FormEvent } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { releaseHold } from '../../api/endpoints.js'
import { Card, CardHeader, Field, Input, Button, ErrorNote } from '../../ui/primitives.js'

// Hold release (Phase 7 Task 10, reskin of the spec-13 build). The confirmed
// ops-edge contract (apps/ops-edge/src/ops.controller.ts's release): posts
// to /ops/records/:asgnId/release with NO body, only a fresh
// Idempotency-Key AND the 'hold-release' stepUpKey (OPS_STEP_UP_GATED_OPERATIONS,
// packages/authz/src/stepup-operations.ts, a spine file this task does not
// touch), the step-up-gated counterpart to Task 9's non-gated HoldButton
// (../operations/HoldButton.tsx).
//
// The assignment id is a WIRE asgn id (B_edge_contracts.md #9, shape-matched)
// with no ops-edge read that discovers one anywhere - the same reality as
// HoldButton's own free-text asgnId field and BatchPage's tenant/program
// inputs, so free text is the only honest source here.
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
    <Card>
      <CardHeader title="Release hold" subtitle="Release an operational hold on an assignment. Requires step-up." />
      <form
        onSubmit={(e) => {
          void handleSubmit(e)
        }}
        className="flex flex-wrap items-end gap-3 p-5 pt-4"
      >
        <Field label="Assignment ID" htmlFor="release-asgnId">
          <Input id="release-asgnId" value={asgnId} onChange={(e) => setAsgnId(e.target.value)} placeholder="asgn_..." />
        </Field>
        <Button type="submit" variant="danger" disabled={busy} loading={busy}>
          Release
        </Button>
      </form>

      {error !== null && (
        <div className="px-5 pb-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {result !== null && (
        <div className="px-5 pb-5 text-sm text-foreground">
          {result.deduped ? 'Already released (deduped). ' : ''}
          {result.released ? 'Released.' : 'Not released.'}
        </div>
      )}
    </Card>
  )
}
