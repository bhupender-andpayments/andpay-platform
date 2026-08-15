import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { editUnitDetails, type UnitInventoryRow, type UnitDetailsPatch, type VendorRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, Input, InfoNote } from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

// Correcting what a device IS, as opposed to where it has reached.
//
// Deliberately a SEPARATE dialog from UnitStatusEditDialog even though both
// edit the same row. They answer different questions and carry different
// risks: a status move is a lifecycle event with a forward-only guard behind
// it, while this is a data correction for a bad intake row. Folding them into
// one form would put an irreversible lifecycle move one tab away from fixing a
// typo.
//
// ONLY THE FOUR MASTER-DATA FIELDS. Batch, shipment, merchant and dispatch are
// pipeline state written by the flows that own them (the return sheet pairs a
// device to its dispatch, the courier rail moves it on), so letting an operator
// retype one here would let this console contradict the facts the rest of the
// platform already acted on.

export function UnitDetailsEditDialog({
  unit,
  vendors,
  open,
  onOpenChange,
  onSaved,
}: {
  unit: UnitInventoryRow
  /** For the manufacturer picker. Filtered to manufacturers by the caller. */
  vendors: readonly VendorRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (patch: UnitDetailsPatch) => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [deviceSerial, setDeviceSerial] = useState('')
  const [simNo, setSimNo] = useState('')
  const [manufacturer, setManufacturer] = useState('')
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seeded from the row on every open, so cancelling and reopening shows what
  // is actually stored rather than the last abandoned edit.
  useEffect(() => {
    if (!open) return
    setDeviceSerial(unit.deviceSerial ?? '')
    setSimNo(unit.simNo ?? '')
    setManufacturer(unit.manufacturerVndr ?? '')
    setLocation(unit.location ?? '')
    setError(null)
  }, [open, unit])

  /**
   * Only what actually changed is sent. An unchanged field is omitted entirely
   * rather than written back with its current value, so two operators editing
   * different fields of the same device cannot silently undo each other.
   */
  function buildPatch(): UnitDetailsPatch {
    const patch: UnitDetailsPatch = {}
    const trimmedSerial = deviceSerial.trim()
    if (trimmedSerial !== (unit.deviceSerial ?? '')) patch.deviceSerial = trimmedSerial
    const trimmedSim = simNo.trim()
    if (trimmedSim !== (unit.simNo ?? '')) patch.simNo = trimmedSim === '' ? null : trimmedSim
    if (manufacturer !== (unit.manufacturerVndr ?? '')) patch.manufacturerVndr = manufacturer
    const trimmedLocation = location.trim()
    if (trimmedLocation !== (unit.location ?? '')) patch.location = trimmedLocation === '' ? null : trimmedLocation
    return patch
  }

  const patch = buildPatch()
  const nothingChanged = Object.keys(patch).length === 0
  const serialEmptied = deviceSerial.trim() === ''

  async function save(): Promise<void> {
    if (nothingChanged || serialEmptied) return
    setSaving(true)
    setError(null)
    try {
      await editUnitDetails(client, unit.id, patch, newIdempotencyKey())
      onSaved(patch)
      onOpenChange(false)
      toast('Device details updated')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the device.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit device details</DialogTitle>
          <DialogDescription>
            Corrects what the manufacturer&apos;s intake file recorded. This does not move the device along its
            lifecycle.
          </DialogDescription>
        </DialogHeader>

        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-3">
          <Field label="Device ID" htmlFor="unit-serial" hint="Must stay unique. Everything else joins on this.">
            <Input id="unit-serial" value={deviceSerial} onChange={(e) => setDeviceSerial(e.target.value)} />
          </Field>
          <Field label="SIM" htmlFor="unit-sim" hint="Clear it to record that no SIM is fitted.">
            <Input id="unit-sim" value={simNo} onChange={(e) => setSimNo(e.target.value)} />
          </Field>
          <Field label="Manufacturer" htmlFor="unit-mfr">
            {/* A picker, never free text: a typo here would point the device at
                a manufacturer that does not exist and blank its name on every
                screen that resolves it. */}
            <SearchSelect
              id="unit-mfr"
              placeholder="Pick a manufacturer…"
              value={manufacturer}
              onChange={setManufacturer}
              options={vendors.map((v) => ({ value: v.id, label: v.displayName }))}
            />
          </Field>
          <Field label="Location" htmlFor="unit-location">
            <Input id="unit-location" value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
        </div>

        {serialEmptied && <InfoNote>A Device ID is required. It is the key every other record joins on.</InfoNote>}

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={nothingChanged || serialEmptied} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
