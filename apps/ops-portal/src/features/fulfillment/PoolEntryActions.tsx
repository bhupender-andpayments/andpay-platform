import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { holdRecord, releaseHold, type PoolEntryRow } from '../../api/endpoints.js'
import { Button, ErrorNote, Field, Input, CodeChip } from '../../ui/primitives.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
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
// NO STEP-UP ON EITHER ACTION as of 19 Aug 2026. Release used to be gated by
// 'hold-release', so an operator more than five minutes past login was asked
// for a TOTP to undo a hold they had just placed; that entry was removed from
// OPS_STEP_UP_CATALOG at the product owner's direction (the reasoning, and the
// architecture-review flag, are recorded in packages/authz/src/stepup.ts).
//
// Nothing changes HERE, and that is the point worth keeping: this component
// makes no authorization decision of its own (S24/T14). It renders both actions
// enabled and lets the edge be the authority, and the step-up round trip, when
// some other action does need one, is owned by the client interceptor and
// StepUpDialog rather than by any calling component. So the TOTP prompt
// disappearing from Release is entirely a consequence of the edge no longer
// answering 403 step-up-required, with no client-side list to keep in sync.

// 12 Aug 2026: a HOLD now carries a reason, so it stops being one click. The
// reason is REQUIRED (the edge rejects a blank one before it authorizes
// anything), and holding keeps a merchant's real order out of every batch for
// as long as it stands, so asking for a sentence is the point rather than
// friction.
//
// 23 Aug 2026: RELEASE NOW CONFIRMS TOO. It stayed one click on the reasoning
// that returning a record to the ordinary pool makes no claim needing
// justification. True as far as it goes, but it understated the consequence:
// the released parcel can be swept into the very next batch and sent to the
// print vendor, which is the outcome the hold was placed to prevent. It still
// asks for no reason, only for confirmation.
//
// 2026-08-14: the reason is collected in a DIALOG rather than a form that
// expanded inside the table cell. The in-cell form re-flowed every row under it
// while the operator typed, and every other reasoned write in this portal is a
// dialog now, so this one stopped being the exception.
//
// The cap mirrors the edge's own MAX_TRIGGER_REASON_LENGTH. Two checks, one
// number: this one gives immediate feedback, the edge is the guarantee.
const MAX_HOLD_REASON_LENGTH = 500

export function PoolEntryActions({
  row,
  onChanged,
  showReason = true,
}: {
  row: PoolEntryRow
  onChanged: () => void
  /**
   * Whether to repeat the hold reason next to the button.
   *
   * True on the Pool page, where this component IS the only place the reason
   * appears in the row. False on the dispatch detail page, whose Held banner
   * states the reason prominently already, and where repeating it inside the
   * same card printed it twice (23 Aug 2026).
   */
  showReason?: boolean
}) {
  const { client } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [holding, setHolding] = useState(false)
  const [releasing, setReleasing] = useState(false)
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
      setReleasing(false)
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
    return (row.holdReason ?? null) === null || !showReason ? null : (
      <span className="text-xs text-muted-foreground">{row.holdReason}</span>
    )
  }

  if (action === 'release') {
    return (
      <div className="flex flex-col items-start gap-1">
        {showReason && (row.holdReason ?? null) !== null && (
          <span className="text-xs text-muted-foreground">Held: {row.holdReason}</span>
        )}
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setReleasing(true)}>
          Release hold
        </Button>
        {/* RELEASE ASKS FIRST (23 Aug 2026). It used to fire on the single
            click, and it is not a small act: the parcel rejoins the pool and
            the very next batch trigger can sweep it to the print vendor, which
            is exactly what the hold existed to prevent. Holding already asks
            for a reason, so the two directions are now symmetric. */}
        <ConfirmDialog
          open={releasing}
          onOpenChange={setReleasing}
          title="Release this hold?"
          description={`${row.merchantDisplayName} rejoins the pool and can be swept into the next batch.${
            (row.holdReason ?? null) !== null ? ` It was held because: ${row.holdReason}` : ''
          }`}
          confirmLabel="Release hold"
          busy={busy}
          error={error}
          onConfirm={() => {
            void run('release')
          }}
        />
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
