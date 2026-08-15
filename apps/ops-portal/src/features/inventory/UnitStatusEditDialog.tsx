import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { correctUnitStatus, type UnitInventoryRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, Input, StatusPill } from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { legalNextStatuses, statusLabel } from './unitStatus.js'

// ONE status editor, for every screen that edits a status.
//
// It was built on the device detail page and was already per-unit rather than
// per-page (keyed entirely off one row's id and status), so the inventory
// list's new inline action reuses it verbatim instead of growing a second
// dialog that would drift from this one. The only thing either caller supplies
// is WHICH row, and what to do with the saved result.
//
// The caller patches its own state from `onSaved` rather than this component
// refetching. The list holds an array and the detail page holds a single row;
// a dialog that tried to own that would have to know which.

export function UnitStatusEditDialog({
  unit,
  open,
  onOpenChange,
  onSaved,
  presetStatus,
}: {
  unit: UnitInventoryRow
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The new status, once the edge has accepted it. */
  onSaved: (status: string) => void
  /**
   * Opens with this status already chosen. Used by the "Mark damaged"
   * shortcut, which is the same write with one fewer decision to make.
   */
  presetStatus?: string
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [newStatus, setNewStatus] = useState('')
  const [occurredAt, setOccurredAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = legalNextStatuses(unit.status)

  // Re-seeded on every open, not once on mount: the list keeps this component
  // mounted across rows, so a stale selection from the previous device would
  // otherwise be pre-filled for the next one.
  useEffect(() => {
    if (!open) return
    setNewStatus(presetStatus !== undefined && options.includes(presetStatus) ? presetStatus : (options[0] ?? ''))
    setOccurredAt('')
    setError(null)
  }, [open, presetStatus, unit.id])

  async function save(): Promise<void> {
    if (newStatus === '') return
    setSaving(true)
    setError(null)
    try {
      const occurredAtIso = occurredAt === '' ? undefined : new Date(occurredAt).toISOString()
      await correctUnitStatus(client, unit.id, newStatus, newIdempotencyKey(), occurredAtIso)
      onSaved(newStatus)
      onOpenChange(false)
      toast(`Status updated to ${statusLabel(newStatus)}`)
    } catch (err) {
      // Inline, not a toast: the operator is still in the dialog and the error
      // belongs next to the control that caused it.
      setError(err instanceof Error ? err.message : 'Failed to update the status.')
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
            {unit.deviceSerial ?? unit.id} is currently <StatusPill value={unit.status} />. Moving forward only - this
            cannot be undone once saved.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="space-y-3">
          <div className="space-y-2">
            <label htmlFor="unit-status-select" className="text-sm font-medium">
              New status
            </label>
            <SearchSelect
              id="unit-status-select"
              placeholder="Pick a status…"
              options={options.map((s) => ({ value: s, label: statusLabel(s) }))}
              value={newStatus}
              onChange={setNewStatus}
            />
          </div>
          {/* For the operator updating days late: when the move REALLY
              happened. Optional; blank means now. The hint is honest about the
              named backend ask (see correctUnitStatus in api/endpoints.ts). */}
          <Field
            label="When it happened"
            htmlFor="unit-status-occurred"
            hint="Optional. Leave empty for now; stored with the correction once the backend keeps a status history."
          >
            <Input
              id="unit-status-occurred"
              type="datetime-local"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </Field>
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
