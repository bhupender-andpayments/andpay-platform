import { editBankMaster, type BankMasterEditBody, type BankMasterRow } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useAuth } from '../../auth/AuthContext.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, Input, Select, CodeChip } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useCreateDialog } from './useCreateDialog.js'

// Edit a bank master (POST /ops/bank-masters/:id/edit), the route that already
// existed and was never called from the portal (18 Aug 2026).
//
// THE BANK REFERENCE CODE IS NOT EDITABLE HERE, shown as plain text instead of
// a field: it is the immutable ingest resolver key (see BankMasterCreateDialog's
// own note on this), and the edit route itself never accepts it.
//
// Every other BRD D.1 field is nullable on the row (an ingest auto-mint leaves
// them all null), so each seeds from the row's value or an empty string, never
// from a placeholder that would be mistaken for real data.

const STATUSES = ['ACTIVE', 'SUSPENDED'] as const

export function BankMasterEditDialog({
  bank,
  open,
  onOpenChange,
  onSaved,
}: {
  bank: BankMasterRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, setValue, filled, saving, error, save } = useCreateDialog(open, () => ({
    displayName: bank.displayName,
    address1: bank.address1 ?? '',
    address2: bank.address2 ?? '',
    address3: bank.address3 ?? '',
    city: bank.city ?? '',
    district: bank.district ?? '',
    country: bank.country ?? '',
    pin: bank.pin ?? '',
    mobile: bank.mobile ?? '',
    email: bank.email ?? '',
    status: bank.status,
  }))

  const incomplete = !filled('displayName')

  // Only fields the operator actually changed go on the wire: editBankMaster
  // is a partial COALESCE update, and sending every field back unconditionally
  // would work too, but this keeps the request an honest diff of the edit.
  const FIELDS: ReadonlyArray<[keyof BankMasterEditBody, string]> = [
    ['displayName', bank.displayName],
    ['address1', bank.address1 ?? ''],
    ['address2', bank.address2 ?? ''],
    ['address3', bank.address3 ?? ''],
    ['city', bank.city ?? ''],
    ['district', bank.district ?? ''],
    ['country', bank.country ?? ''],
    ['pin', bank.pin ?? ''],
    ['mobile', bank.mobile ?? ''],
    ['email', bank.email ?? ''],
    ['status', bank.status],
  ]

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const body: BankMasterEditBody = {}
      for (const [key, original] of FIELDS) {
        const value = f(key).trim()
        if (value !== original) body[key] = value
      }
      const result = await editBankMaster(client, bank.tnntId, body, newIdempotencyKey())
      onOpenChange(false)
      onSaved()
      toast(
        result.deduped
          ? `${bank.displayName} was already saved`
          : `${bank.displayName} updated (${result.changedFields.length} field${result.changedFields.length === 1 ? '' : 's'})`,
      )
    }, 'Failed to save this bank master.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit bank master</DialogTitle>
          <DialogDescription>
            <CodeChip>{bank.bankReferenceCode}</CodeChip> is the ingest resolver key and cannot be changed here.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-4">
          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Identity</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Display name" htmlFor="bm-edit-name">
                <Input id="bm-edit-name" value={f('displayName')} onChange={set('displayName')} />
              </Field>
              <Field label="Status" htmlFor="bm-edit-status">
                <Select
                  id="bm-edit-status"
                  value={f('status')}
                  onChange={(e) => {
                    setValue('status', e.target.value)
                  }}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Address</h3>
            <Field label="Address 1" htmlFor="bm-edit-addr1" hint="Optional.">
              <Input id="bm-edit-addr1" value={f('address1')} onChange={set('address1')} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Address 2" htmlFor="bm-edit-addr2" hint="Optional.">
                <Input id="bm-edit-addr2" value={f('address2')} onChange={set('address2')} />
              </Field>
              <Field label="Address 3" htmlFor="bm-edit-addr3" hint="Optional.">
                <Input id="bm-edit-addr3" value={f('address3')} onChange={set('address3')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City" htmlFor="bm-edit-city" hint="Optional.">
                <Input id="bm-edit-city" value={f('city')} onChange={set('city')} />
              </Field>
              <Field label="District" htmlFor="bm-edit-district" hint="Optional.">
                <Input id="bm-edit-district" value={f('district')} onChange={set('district')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" htmlFor="bm-edit-country" hint="Optional.">
                <Input id="bm-edit-country" value={f('country')} onChange={set('country')} />
              </Field>
              <Field label="PIN" htmlFor="bm-edit-pin" hint="Optional.">
                <Input id="bm-edit-pin" value={f('pin')} onChange={set('pin')} />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Contact</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mobile" htmlFor="bm-edit-mobile" hint="Optional. 10 digits.">
                <Input id="bm-edit-mobile" value={f('mobile')} inputMode="numeric" maxLength={10} onChange={set('mobile')} />
              </Field>
              <Field label="Email" htmlFor="bm-edit-email" hint="Optional.">
                <Input id="bm-edit-email" type="email" value={f('email')} onChange={set('email')} />
              </Field>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={incomplete} loading={saving}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
