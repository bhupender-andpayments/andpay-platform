import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { correctStatus, overrideTerminal } from '../../api/endpoints.js'
import { Button, ErrorNote, Field, Input, InfoNote } from '../../ui/primitives.js'
import { IconShield } from '../../ui/icons.js'
import { SearchSelect } from '../../components/Picker.js'
import { useToast } from '../../ui/Toast.js'
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

const KNOWN_STATUSES = [
  'DISPATCHED_BY_VENDOR',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'RETURNED',
] as const

interface ShipmentActionProps {
  shptId: string
  awb: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The write landed: reload the trail so the new event is on screen. */
  onSaved: () => void
}

export function CorrectStatusDialog({ shptId, awb, open, onOpenChange, onSaved }: ShipmentActionProps) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [status, setStatus] = useState<string>('')
  const [courierTimestamp, setCourierTimestamp] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seeded on every open so a cancelled attempt does not pre-fill the next.
  useEffect(() => {
    if (!open) return
    setStatus('')
    setCourierTimestamp('')
    setError(null)
  }, [open])

  async function save(): Promise<void> {
    if (status === '' || courierTimestamp === '') return
    setBusy(true)
    setError(null)
    try {
      await correctStatus(client, shptId, { status, courierTimestamp }, newIdempotencyKey())
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
              options={KNOWN_STATUSES.map((s) => ({ value: s, label: s }))}
            />
          </Field>
          <Field label="When it happened" htmlFor="correct-courierTimestamp" hint="The courier's time, not now.">
            <Input
              id="correct-courierTimestamp"
              type="datetime-local"
              value={courierTimestamp}
              onChange={(e) => setCourierTimestamp(e.target.value)}
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
            disabled={status === '' || courierTimestamp === ''}
            loading={busy}
          >
            Record update
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function OverrideStatusDialog({ shptId, awb, open, onOpenChange, onSaved }: ShipmentActionProps) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [status, setStatus] = useState<string>('')
  const [courierTimestamp, setCourierTimestamp] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStatus('')
    setCourierTimestamp('')
    setOverrideReason('')
    setError(null)
  }, [open])

  const incomplete = status === '' || courierTimestamp === '' || overrideReason.trim() === ''

  async function save(): Promise<void> {
    if (incomplete) return
    setBusy(true)
    setError(null)
    try {
      await overrideTerminal(
        client,
        shptId,
        { status, courierTimestamp, overrideReason: overrideReason.trim() },
        newIdempotencyKey(),
      )
      onOpenChange(false)
      toast(`Status overridden to ${status}`)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit the terminal override.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Override status</DialogTitle>
          <DialogDescription>
            Force-sets <span className="num">{awb}</span> past the normal ladder. Recorded with your name and reason.
          </DialogDescription>
        </DialogHeader>
        <InfoNote>
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <IconShield width={15} height={15} className="text-primary" />
            Step-up required
          </span>
          : you will be asked for your authenticator code.
        </InfoNote>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <div className="space-y-3">
          <Field label="Status" htmlFor="override-status">
            <SearchSelect
              id="override-status"
              placeholder="Pick one…"
              value={status}
              onChange={setStatus}
              options={KNOWN_STATUSES.map((s) => ({ value: s, label: s }))}
            />
          </Field>
          <Field label="When it happened" htmlFor="override-courierTimestamp" hint="The courier's time, not now.">
            <Input
              id="override-courierTimestamp"
              type="datetime-local"
              value={courierTimestamp}
              onChange={(e) => setCourierTimestamp(e.target.value)}
            />
          </Field>
          <Field label="Override reason" htmlFor="override-reason" hint="Why the ladder is being bypassed.">
            <Input id="override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={() => void save()} disabled={incomplete} loading={busy}>
            Override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
