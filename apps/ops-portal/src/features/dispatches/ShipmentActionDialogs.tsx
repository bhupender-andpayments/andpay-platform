import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { correctStatus } from '../../api/endpoints.js'
import { Button, ErrorNote, Field } from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import { useToast } from '../../ui/Toast.js'
import { COURIER_STATUSES } from '../dashboards/courierStatuses.js'
import { SHIPMENT_RUNG } from './dispatchStatus.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

// The two shipment writes, as dialogs ON THE SHIPMENT'S OWN PAGE.
//
// They used to be buttons on every row of the dispatch list, injecting their
// full form between the tiles and the grid when clicked. Moving them here puts
// the action on the thing it changes, next to the carrier history it will
// append to, and the AWB in the dialog title is the same AWB in the page
// header, so there is no way to correct the wrong parcel by eye-matching ids.
//
// The contracts are unchanged from the forms these replace (Phase 7 Tasks 9
// and 10): correct posts { status, courierTimestamp } to
// /ops/shipments/:id/correct, NOT step-up-gated; override posts
// { status, courierTimestamp, overrideReason } to /ops/shipments/:id/override
// and IS step-up-gated ('terminal-override'), where a 403 drives the real TOTP
// dialog via the client interceptor and retries once with the SAME idempotency
// key. Neither component makes any authorization decision (S24/T14).
//
// The shipment id is always the page's own `shipment.id`, a real wire id from
// the shipment list read, never typed and never fabricated.
//
// The timestamp is a datetime-local input rather than the raw text box the old
// forms had ("2026-08-01T10:00" by hand): the browser's picker produces exactly
// the format the edge accepts, and an operator cannot mistype a month.

interface ShipmentActionProps {
  shptId: string
  awb: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The write landed: reload the trail so the new event is on screen. */
  onSaved: () => void
}

/**
 * The statuses `advanceShipmentStatus` would actually apply from here
 * (23 Aug 2026). The dialog used to offer all seven, and the domain's
 * forward-only guard then refused the illegal ones by updating zero rows
 * while the trail event still landed, so an operator could pick DELIVERED
 * -> FAILED, be toasted success, and leave the page disagreeing with itself
 * (the rail reads shpt.status, the history reads the events). Mirroring the
 * guard here means the dialog cannot ask for what the server will not do:
 * from a ladder rung, only HIGHER rungs plus the off-ladder pair
 * (FAILED/RETURNED); from FAILED, everything except FAILED again; from a
 * terminal, nothing, and the page offers Override instead.
 */
export function legalCorrectionsFrom(currentStatus: string): string[] {
  if (currentStatus === 'DELIVERED' || currentStatus === 'RETURNED') return []
  const currentRank = SHIPMENT_RUNG[currentStatus]
  return COURIER_STATUSES.filter((s) => {
    if (s === currentStatus) return false
    const rank = SHIPMENT_RUNG[s]
    if (rank === undefined) return true // FAILED / RETURNED: off-ladder, always a legal move
    return currentRank === undefined ? true : rank > currentRank
  })
}

export function CorrectStatusDialog({
  shptId,
  awb,
  currentStatus,
  open,
  onOpenChange,
  onSaved,
}: ShipmentActionProps & { currentStatus: string }) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [status, setStatus] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seeded on every open so a cancelled attempt does not pre-fill the next.
  useEffect(() => {
    if (!open) return
    setStatus('')
    setError(null)
  }, [open])

  async function save(): Promise<void> {
    if (status === '') return
    setBusy(true)
    setError(null)
    try {
      // The instant is taken at submit, not typed (2026-08-17 ruling): every
      // status surface stamps system time. The edge still requires the field,
      // so it is sent, just never asked for.
      const courierTimestamp = new Date().toISOString()
      const result = await correctStatus(client, shptId, { status, courierTimestamp }, newIdempotencyKey())
      // THE OUTCOME IS CHECKED (23 Aug 2026). 'trail_only' means the guarded
      // UPDATE moved nothing (the parcel advanced past this status, or reached
      // a terminal, between page load and submit): the event was recorded but
      // the status did not change, and toasting success for that is how the
      // rail and the history came to disagree on screen.
      if (result.outcome === 'trail_only') {
        setError(
          'The courier status did not change: the parcel has already moved past this status. Reload the page to see where it is now.',
        )
        onSaved()
        return
      }
      onOpenChange(false)
      toast(`Courier status corrected to ${status}`)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the status correction.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record courier update</DialogTitle>
          <DialogDescription>
            Adds an update the courier file missed for <span className="num">{awb}</span>. Forward only.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="space-y-3">
          <Field label="Status" htmlFor="correct-status">
            <SearchSelect
              id="correct-status"
              placeholder="Pick one…"
              value={status}
              onChange={setStatus}
              options={legalCorrectionsFrom(currentStatus).map((s) => ({ value: s, label: s }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={status === ''}
            loading={busy}
          >
            Record update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// OverrideStatusDialog LIVED HERE and is gone (23 Aug 2026, at the user's
// direction). It drove POST /ops/shipments/:id/override, the sanctioned C3
// bypass: the only write that can leave a terminal DELIVERED/RETURNED, gated
// on a step-up TOTP and a mandatory override_reason.
//
// It was removed from the product, not just from this file: a parcel that
// reached a terminal has finished travelling, and a second red button offering
// to un-finish it read as a confusing duplicate of the ordinary update, with a
// TOTP prompt in the middle of routine work. The shipment page now shows one
// button, disabled once the parcel is terminal.
//
// THE ROUTE AND THE DOMAIN FUNCTION REMAIN (ops.controller.ts override(),
// services/fulfillment/src/ops.ts overrideTerminal), with their tests: the
// server-side capability is a real one and removing it is an architecture
// decision, not a UI one. Nothing in this portal calls it.
