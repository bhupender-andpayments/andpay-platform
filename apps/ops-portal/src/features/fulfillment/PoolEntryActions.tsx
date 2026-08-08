import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { holdRecord, releaseHold, type PoolEntryRow } from '../../api/endpoints.js'
import { Button, ErrorNote } from '../../ui/primitives.js'

// Redesign step 8: the last of the typed wire ids.
//
// Hold and Release were two standalone forms, each asking the operator to type
// an `asgn_...` id. Their own comments justified that by saying no ops-edge read
// discovered an assignment id anywhere, so free text was "the only honest
// source". That was TRUE when written and stopped being true when the P2-1
// object-spine reads landed: GET /ops/pool returns asgnId on every row. The
// premise expired and nobody went back to it.
//
// Both actions are one click, and WHICH one applies is decided by the row's own
// pool status, so they belong on the row. The old forms could not know that:
// they accepted any id and let the edge reject the nonsensical combinations.
//
// STEP-UP IS UNCHANGED. Release is gated by 'hold-release' in
// OPS_STEP_UP_GATED_OPERATIONS, and the round trip is owned by the client
// interceptor and StepUpDialog, not by the calling component. Moving the call
// from a form onto a row does not touch that, and this component makes no
// authorization decision of its own (S24/T14): it renders the action enabled
// and lets the edge be the authority.

export function PoolEntryActions({ row, onChanged }: { row: PoolEntryRow; onChanged: () => void }) {
  const { client } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: 'hold' | 'release'): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      if (action === 'hold') await holdRecord(client, row.asgnId, newIdempotencyKey())
      else await releaseHold(client, row.asgnId, newIdempotencyKey())
      // Re-read rather than patch the row locally: the server decides what the
      // entry now is, and a locally-guessed status that disagreed with it would
      // be worse than a brief wait.
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} this record.`)
    } finally {
      setBusy(false)
    }
  }

  // BATCHED and anything else: no action. A hold only means something while an
  // entry is still waiting to be batched.
  const action = row.poolStatus === 'POOLED' ? 'hold' : row.poolStatus === 'HELD' ? 'release' : null

  if (action === null) return null

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        loading={busy}
        onClick={() => {
          void run(action)
        }}
      >
        {action === 'hold' ? 'Hold' : 'Release hold'}
      </Button>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </div>
  )
}
