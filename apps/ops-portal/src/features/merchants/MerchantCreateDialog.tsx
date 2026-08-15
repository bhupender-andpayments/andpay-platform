import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { createMerchant, type MerchantCreateBody } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, Input } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

// Adding a merchant by hand, for the case the normal door cannot serve: every
// merchant today is born from a bank request file, and a merchant who needs to
// exist BEFORE any file mentions them (a pilot, a correction, a bank that is
// late with its sheet) had no door at all.
//
// UI-FIRST BY DECISION (2026-08-14): the backend team owns the route this posts
// to (POST /ops/merchants, contract in api/endpoints.ts). Until it lands, a
// save surfaces the edge's 404 inline here, which is the honest failure.
//
// THE FIELDS ARE THE BRD'S (section 5.1, the bank-file field table), not a
// screen's invention: identity (business name, legal name, MCC, VPA - the
// BRD's unique merchant key), contact (name, mobile, email), and the dispatch
// address block. What is deliberately ABSENT is everything that belongs to a
// REQUEST rather than a merchant: bank, branch, QR string and the kit
// quantities all arrive on the bank request file, which remains the door for
// asking for hardware. Status is the server's to default.
//
// The regex checks below are immediate keyboard feedback only; the server
// remains the authority on every one of them.

function digits(value: string, length: number): boolean {
  return new RegExp(`^\\d{${String(length)}}$`).test(value.trim())
}

export function MerchantCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset on every open so an abandoned draft never pre-fills the next one.
  useEffect(() => {
    if (!open) return
    setForm({})
    setError(null)
  }, [open])

  const f = (key: string): string => form[key] ?? ''
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }))
  }

  const mccOk = digits(f('mcc'), 4)
  const mobileOk = digits(f('mobile'), 10)
  const pincodeOk = digits(f('pincode'), 6)
  const vpaOk = f('vpa').trim().includes('@')
  const emailOk = f('email').trim() === '' || /^\S+@\S+$/.test(f('email').trim())
  const mandatoryFilled = ['displayName', 'legalName', 'contactName', 'address', 'city', 'state'].every(
    (k) => f(k).trim() !== '',
  )
  const incomplete = !mandatoryFilled || !mccOk || !mobileOk || !pincodeOk || !vpaOk || !emailOk

  async function save(): Promise<void> {
    if (incomplete) return
    setSaving(true)
    setError(null)
    try {
      const body: MerchantCreateBody = {
        displayName: f('displayName').trim(),
        legalName: f('legalName').trim(),
        mcc: f('mcc').trim(),
        vpa: f('vpa').trim(),
        contactName: f('contactName').trim(),
        mobile: f('mobile').trim(),
        ...(f('email').trim() !== '' ? { email: f('email').trim() } : {}),
        address: f('address').trim(),
        ...(f('address2').trim() !== '' ? { address2: f('address2').trim() } : {}),
        ...(f('address3').trim() !== '' ? { address3: f('address3').trim() } : {}),
        city: f('city').trim(),
        state: f('state').trim(),
        pincode: f('pincode').trim(),
      }
      await createMerchant(client, body, newIdempotencyKey())
      onOpenChange(false)
      toast(`${body.displayName} added`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add the merchant.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add merchant</DialogTitle>
          <DialogDescription>
            For a merchant no bank file has carried yet. The normal door remains the bank request upload, which
            creates merchants on its own.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-4">
          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Identity</h3>
            <Field label="Business name" htmlFor="mrch-display" hint="The name operators will search for.">
              <Input id="mrch-display" value={f('displayName')} onChange={set('displayName')} />
            </Field>
            <Field label="Legal name" htmlFor="mrch-legal">
              <Input id="mrch-legal" value={f('legalName')} onChange={set('legalName')} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="MCC" htmlFor="mrch-mcc" hint="4-digit category code.">
                <Input id="mrch-mcc" value={f('mcc')} inputMode="numeric" maxLength={4} onChange={set('mcc')} />
              </Field>
              <Field label="VPA" htmlFor="mrch-vpa" hint="The UPI ID. One merchant per VPA.">
                <Input id="mrch-vpa" value={f('vpa')} placeholder="name@bank" onChange={set('vpa')} />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Contact</h3>
            <Field label="Contact name" htmlFor="mrch-contact">
              <Input id="mrch-contact" value={f('contactName')} onChange={set('contactName')} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mobile" htmlFor="mrch-mobile" hint="10 digits.">
                <Input
                  id="mrch-mobile"
                  value={f('mobile')}
                  inputMode="numeric"
                  maxLength={10}
                  onChange={set('mobile')}
                />
              </Field>
              <Field label="Email" htmlFor="mrch-email" hint="Optional.">
                <Input id="mrch-email" type="email" value={f('email')} onChange={set('email')} />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Dispatch address
            </h3>
            <Field label="Address" htmlFor="mrch-address">
              <Input id="mrch-address" value={f('address')} onChange={set('address')} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Address 2" htmlFor="mrch-address2" hint="Optional.">
                <Input id="mrch-address2" value={f('address2')} onChange={set('address2')} />
              </Field>
              <Field label="Address 3" htmlFor="mrch-address3" hint="Optional.">
                <Input id="mrch-address3" value={f('address3')} onChange={set('address3')} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="City" htmlFor="mrch-city">
                <Input id="mrch-city" value={f('city')} onChange={set('city')} />
              </Field>
              <Field label="State" htmlFor="mrch-state">
                <Input id="mrch-state" value={f('state')} onChange={set('state')} />
              </Field>
              <Field label="Pincode" htmlFor="mrch-pincode" hint="6 digits.">
                <Input
                  id="mrch-pincode"
                  value={f('pincode')}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={set('pincode')}
                />
              </Field>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={incomplete} loading={saving}>
            Add merchant
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
