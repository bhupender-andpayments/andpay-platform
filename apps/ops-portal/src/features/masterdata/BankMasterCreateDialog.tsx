import { createBankMaster, type BankMasterCreateBody } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useAuth } from '../../auth/AuthContext.js'
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
import { useCreateDialog } from './useCreateDialog.js'

// Add a bank master (POST /ops/bank-masters, BRD Annexure D.1). The "bank" is
// the identity tenant; until this dialog the only way one came into existence
// was the ingest auto-mint, which knows nothing but the code and so leaves
// every address and contact field null.
//
// THE BANK REFERENCE CODE IS THE ONE FIELD THAT CAN BE SILENTLY WRONG, and the
// hint below is the whole reason this dialog needs care. It is the immutable
// ingest resolver key. If it does not match the code this bank's own FILE
// resolves to, nothing errors: ingest simply auto-mints a SECOND tenant for the
// real code and this record sits unused forever, with its address and contact
// never reaching a single dispatch. For the Annexure B layout the file resolves
// on the PARTNER code declared in the profile (`GSCB`), not on the per-row
// numeric aggregator code, which is the mistake the hint names.
//
// Every field except address2/address3 is mandatory per BRD D.1 and is enforced
// server-side too (createBankMaster's requireField); the checks here are
// keyboard feedback, never the authority.

export function BankMasterCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, filled, saving, error, save } = useCreateDialog(open)

  const emailOk = /^\S+@\S+$/.test(f('email').trim())
  const mobileOk = /^\d{10}$/.test(f('mobile').trim())
  const incomplete =
    !filled('bankReferenceCode', 'displayName', 'address1', 'city', 'district', 'country', 'pin') ||
    !mobileOk ||
    !emailOk

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const body: BankMasterCreateBody = {
        bankReferenceCode: f('bankReferenceCode').trim(),
        displayName: f('displayName').trim(),
        address1: f('address1').trim(),
        ...(f('address2').trim() !== '' ? { address2: f('address2').trim() } : {}),
        ...(f('address3').trim() !== '' ? { address3: f('address3').trim() } : {}),
        city: f('city').trim(),
        district: f('district').trim(),
        country: f('country').trim(),
        pin: f('pin').trim(),
        mobile: f('mobile').trim(),
        email: f('email').trim(),
      }
      const result = await createBankMaster(client, body, newIdempotencyKey())
      onOpenChange(false)
      onCreated()
      toast(result.deduped ? `${body.displayName} was already added` : `${body.displayName} added`)
    }, 'Failed to add the bank master.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add bank master</DialogTitle>
          <DialogDescription>
            The sponsoring bank. A bank must exist here before a merchant can be added against it.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-4">
          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Identity</h3>
            <Field
              label="Bank reference code"
              htmlFor="bm-code"
              hint="Must match the code this bank's request file resolves on, or the file creates a second bank instead of using this one. Cannot be changed later."
            >
              <Input id="bm-code" value={f('bankReferenceCode')} onChange={set('bankReferenceCode')} />
            </Field>
            <Field label="Display name" htmlFor="bm-name">
              <Input id="bm-name" value={f('displayName')} onChange={set('displayName')} />
            </Field>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Address</h3>
            <Field label="Address 1" htmlFor="bm-addr1">
              <Input id="bm-addr1" value={f('address1')} onChange={set('address1')} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Address 2" htmlFor="bm-addr2" hint="Optional.">
                <Input id="bm-addr2" value={f('address2')} onChange={set('address2')} />
              </Field>
              <Field label="Address 3" htmlFor="bm-addr3" hint="Optional.">
                <Input id="bm-addr3" value={f('address3')} onChange={set('address3')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City" htmlFor="bm-city">
                <Input id="bm-city" value={f('city')} onChange={set('city')} />
              </Field>
              <Field label="District" htmlFor="bm-district">
                <Input id="bm-district" value={f('district')} onChange={set('district')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" htmlFor="bm-country">
                <Input id="bm-country" value={f('country')} onChange={set('country')} />
              </Field>
              <Field label="PIN" htmlFor="bm-pin">
                <Input id="bm-pin" value={f('pin')} onChange={set('pin')} />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Contact</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mobile" htmlFor="bm-mobile" hint="10 digits.">
                <Input id="bm-mobile" value={f('mobile')} inputMode="numeric" maxLength={10} onChange={set('mobile')} />
              </Field>
              <Field label="Email" htmlFor="bm-email">
                <Input id="bm-email" type="email" value={f('email')} onChange={set('email')} />
              </Field>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={incomplete} loading={saving}>
            Add bank master
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
