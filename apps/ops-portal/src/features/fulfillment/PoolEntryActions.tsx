import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { holdRecord, releaseHold, type PoolEntryRow } from '../../api/endpoints.js'
import { Button, ErrorNote, Field, Input, CodeChip } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

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

// 12 Aug 2026: a HOLD now carries a reason, so it stops being one click. The
// reason is REQUIRED (the edge rejects a blank one before it authorizes
// anything), and holding keeps a merchant's real order out of every batch for
// as long as it stands, so asking for a sentence is the point rather than
// friction. Release is unchanged and stays one click: it returns the record to
// the ordinary pool, so there is no equivalent claim to justify.
//
// 2026-08-14: the reason is collected in a DIALOG rather than a form that
// expanded inside the table cell. The in-cell form re-flowed every row under it
// while the operator typed, and every other reasoned write in this portal is a
// dialog now, so this one stopped being the exception.
//
// The cap mirrors the edge's own MAX_TRIGGER_REASON_LENGTH. Two checks, one
// number: this one gives immediate feedback, the edge is the guarantee.
const MAX_HOLD_REASON_LENGTH = 500

export function PoolEntryActions({ row, onChanged }: { row: PoolEntryRow; onChanged: () => void }) {
  const { client } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [holding, setHolding] = useState(false)
  const [reason, setReason] = useState('')

  async function run(action: 'hold' | 'release'): Promise<void> {
    setError(null)
    setBusy(true)
    try {
      if (action === 'hold') await holdRecord(client, row.asgnId, reason.trim(), newIdempotencyKey())
      else await releaseHold(client, row.asgnId, newIdempotencyKey())
      // Re-read rather than patch the row locally: the server decides what the
      // entry now is, and a locally-guessed status that disagreed with it would
      // be worse than a brief wait.
      setHolding(false)
      setReason('')
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

  if (action === null) {
    // A HELD row that has since been batched still shows WHY it was held, if a
    // reason was recorded. Losing that the moment the action disappears would
    // throw away the only account of the decision.
    return (row.holdReason ?? null) === null ? null : <span className="text-xs text-muted-foreground">{row.holdReason}</span>
  }

  if (action === 'release') {
    return (
      <div className="flex flex-col items-start gap-1">
        {(row.holdReason ?? null) !== null && <span className="text-xs text-muted-foreground">Held: {row.holdReason}</span>}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          loading={busy}
          onClick={() => {
            void run('release')
          }}
        >
          Release hold
        </Button>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
      </div>
    )
  }

  const trimmed = reason.trim()

  return (
    <>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => setHolding(true)}>
        Hold
      </Button>
      <Dialog
        open={holding}
        onOpenChange={(next) => {
          setHolding(next)
          if (!next) {
            setReason('')
            setError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hold this record</DialogTitle>
            <DialogDescription>
              {row.merchantDisplayName} <CodeChip>{row.asgnId}</CodeChip> stays out of every batch until the hold is
              released. The reason is recorded.
            </DialogDescription>
          </DialogHeader>
          {error !== null && <ErrorNote>{error}</ErrorNote>}
          <Field label="Reason for holding" htmlFor={`hold-reason-${row.asgnId}`}>
            <Input
              id={`hold-reason-${row.asgnId}`}
              value={reason}
              maxLength={MAX_HOLD_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setHolding(false)
                setReason('')
                setError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={busy || trimmed === ''}
              loading={busy}
              onClick={() => {
                void run('hold')
              }}
            >
              Hold this record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
