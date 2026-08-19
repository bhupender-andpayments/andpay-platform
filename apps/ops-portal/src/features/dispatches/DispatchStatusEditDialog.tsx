import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { correctStatus, sendBatchToVendor } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { sendToVendorErrorMessage } from '../fulfillment/sendToVendorError.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, InfoNote, StatusPill } from '../../ui/primitives.js'
import { SearchSelect, type PickerOption } from '../../components/Picker.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  COURIER_RUNG,
  FIRST_COURIER_RUNG,
  TERMINAL_RUNGS,
  nextRungs,
  priorRungs,
  statusLabel,
} from './dispatchStatus.js'

// CHANGE STATUS, from the dispatch page that shows the status.
//
// Deliberately the same dialog grammar as the device editor
// (../inventory/UnitStatusEditDialog.tsx): same title, same "currently X,
// forward only" sentence, the whole ladder in one SearchSelect with the rungs
// behind this dispatch greyed out, Save plus Cancel, the error inline and the
// confirmation as a toast. An operator who has changed a device's status has
// already learned this control.
//
// WHAT IS DIFFERENT, and it is the whole reason this is a separate file rather
// than a prop on that one: a device has ONE writer for every rung
// (POST /ops/units/:id/status). A dispatch has THREE OWNERS across its ladder,
// none of which is a per-dispatch status route, because no such route exists:
//
//   RECEIVED, PENDING_BATCH   the bank file's own ingest, and the pool
//   QR_GENERATED              the batching trigger, in the transaction that
//                             forms the batch
//   SENT_TO_VENDOR            POST /ops/batches/:btchId/send-to-vendor, which
//                             moves EVERY QR_GENERATED row in the batch
//   DISPATCHED_BY_VENDOR ->   the SHIPMENT, via POST /ops/shipments/:id/correct.
//                             A shipment exists only once the vendor's return
//                             sheet has supplied the AWB.
//
// So a rung is offered as selectable only when its real writer is reachable
// right now, and the rest are listed with the reason they are not. That is the
// same device-editor idea (show the ladder whole, grey what cannot be picked)
// applied to a ladder whose obstacle is sometimes ahead of the dispatch rather
// than behind it. Nothing here invents a route or a state (repo DO-NOT list).
//
// NO AUTHORIZATION DECISION IS MADE HERE (S24/T14). The edge re-checks every
// transition: send-to-vendor answers 409 when the batch has already been sent or
// its QR generation is unfinished, and the courier write is forward-only against
// LADDER_RANK. This only decides what a dropdown offers.

/** Why a rung cannot be picked yet. Shown as the option's trailing note. */
const WHY_LOCKED = {
  upstream: 'set upstream',
  needsBatch: 'needs a batch',
  needsAwb: 'needs the vendor AWB',
} as const

export function DispatchStatusEditDialog({
  asgnId,
  merchantDisplay,
  currentKey,
  currentRung,
  batchId,
  shptId,
  courierStatus,
  open,
  onOpenChange,
  onSaved,
}: {
  asgnId: string
  merchantDisplay: string
  /** The rung the page's rail is highlighting, so the two cannot disagree. */
  currentKey: string
  currentRung: number
  batchId: string | null
  shptId: string | null
  courierStatus: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The write landed: reload the dispatch so the rail moves. */
  onSaved: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [newStatus, setNewStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A courier write is forward-only against the shipment's OWN status, which is
  // not always this dispatch's rung: two statuses share a rung (PICKED_UP with
  // the handover, OUT_FOR_DELIVERY with in transit), so a parcel already picked
  // up may not go back to DISPATCHED_BY_VENDOR even though the rail reads the
  // same rung for both.
  const courierRank = courierStatus === null ? -1 : (COURIER_RUNG[courierStatus] ?? -1)

  /** Whether this rung's real writer can be reached right now, and if not, why. */
  function lockOf(key: string, idx: number): string | null {
    if (idx < FIRST_COURIER_RUNG) {
      if (key !== 'SENT_TO_VENDOR') return WHY_LOCKED.upstream
      return batchId === null ? WHY_LOCKED.needsBatch : null
    }
    if (shptId === null) return WHY_LOCKED.needsAwb
    // Terminal stops carry no rung of their own and are reachable from any
    // in-flight position, which is the domain rule (D9, courier-status.ts).
    return idx <= courierRank ? WHY_LOCKED.upstream : null
  }

  const options: PickerOption[] = [
    // Where it has already been. Not selectable (forward only), listed so the
    // dropdown reads as a ladder and not a short list starting somewhere.
    ...priorRungs(currentRung).map((rung) => ({
      value: rung.key,
      label: rung.label,
      disabled: true,
      note: rung.key === currentKey ? 'current' : 'passed',
    })),
    ...nextRungs(currentRung).map((rung, i) => {
      const idx = currentRung + 1 + i
      const lock = lockOf(rung.key, idx)
      return lock === null
        ? { value: rung.key, label: rung.label }
        : { value: rung.key, label: rung.label, disabled: true, note: lock }
    }),
    ...TERMINAL_RUNGS.map((rung) => {
      const lock = shptId === null ? WHY_LOCKED.needsAwb : null
      return lock === null
        ? { value: rung.key, label: rung.label }
        : { value: rung.key, label: rung.label, disabled: true, note: lock }
    }),
  ]

  const selectable = options.filter((o) => o.disabled !== true).map((o) => o.value)

  // Re-seeded on every open so a cancelled attempt does not pre-fill the next,
  // and so a reload that moved the rail does not leave a stale target selected.
  useEffect(() => {
    if (!open) return
    setNewStatus(selectable[0] ?? '')
    setError(null)
  }, [open, asgnId, currentKey])

  async function save(): Promise<void> {
    if (newStatus === '') return
    setSaving(true)
    setError(null)
    try {
      if (newStatus === 'SENT_TO_VENDOR') {
        if (batchId === null) return
        await sendBatchToVendor(client, batchId, newIdempotencyKey())
      } else {
        if (shptId === null) return
        // The instant is stamped at submit, never typed (2026-08-17 ruling, the
        // same one CorrectStatusDialog follows). The edge requires the field, so
        // it is sent and never asked for.
        await correctStatus(
          client,
          shptId,
          { status: newStatus, courierTimestamp: new Date().toISOString() },
          newIdempotencyKey(),
        )
      }
      onOpenChange(false)
      toast(`Status updated to ${statusLabel(newStatus)}`)
      onSaved()
    } catch (err) {
      // Inline rather than a toast: the operator is still in the dialog and the
      // error belongs next to the control that caused it. The send-to-vendor
      // refusals share their wording with the batch pages that offer the same
      // action, because it is the same refusal wherever it is triggered.
      setError(sendToVendorErrorMessage(err, 'Failed to update the status.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change status</DialogTitle>
          <DialogDescription>
            {merchantDisplay} is currently <StatusPill value={currentKey} />. Moving forward only.
          </DialogDescription>
        </DialogHeader>
        {/* The batch-wide consequence, stated before it happens rather than
            discovered afterwards: send-to-vendor has no per-dispatch form. */}
        {newStatus === 'SENT_TO_VENDOR' && (
          <InfoNote>
            This sends the whole batch to the print vendor, so every dispatch in it moves, not only this one.
          </InfoNote>
        )}
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="space-y-2">
          <label htmlFor="dispatch-status-select" className="text-sm font-medium">
            New status
          </label>
          <SearchSelect
            id="dispatch-status-select"
            placeholder="Pick a status…"
            options={options}
            value={newStatus}
            onChange={setNewStatus}
          />
          {selectable.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nothing to move to from here. The next step is owned elsewhere: a batched dispatch advances when its batch
              goes to the print vendor, and the courier rungs open once the vendor's return sheet supplies the AWB.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={newStatus === ''} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
