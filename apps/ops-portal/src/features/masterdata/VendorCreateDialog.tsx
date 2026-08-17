import { createVendor, type VendorCreateBody } from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useAuth } from '../../auth/AuthContext.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, Input, Select } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useCreateDialog } from './useCreateDialog.js'

// Add a vendor (POST /ops/vendors), serving BOTH master-data tabs.
//
// ONE DIALOG, NOT TWO, because a courier IS a vendor row with type COURIER:
// the Courier Master tab is the same /ops/vendors list filtered client-side,
// and it posts to the same route. The tabs differ only in whether the operator
// chooses the type or it is already decided, which `fixedType` expresses. Two
// components would be two copies of one body contract.
//
// courierCode and integrationMode are COURIER-only by the schema's own comment
// (a MANUFACTURER or PRINT row leaves both null), so they are not rendered for
// the other types rather than rendered-and-ignored. No credential of any kind
// belongs here (S4): the class-6 vendor credential is Auth-owned and is issued
// through vendor provisioning, never through master data.

const VENDOR_TYPES: ReadonlyArray<VendorCreateBody['type']> = ['MANUFACTURER', 'PRINT', 'COURIER']
const INTEGRATION_MODES: ReadonlyArray<'WEBHOOK' | 'BATCH'> = ['WEBHOOK', 'BATCH']

export function VendorCreateDialog({
  open,
  onOpenChange,
  onCreated,
  fixedType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  /** Pinned by the Courier Master tab; the Vendor Registry leaves it open. */
  fixedType?: VendorCreateBody['type']
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, setValue, filled, saving, error, save } = useCreateDialog(open)

  const type = (fixedType ?? f('type')) as VendorCreateBody['type'] | ''
  const isCourier = type === 'COURIER'
  // A courier without a code cannot be referenced by the courier-status upload,
  // so it is mandatory for that type and absent for the others.
  const incomplete = !filled('displayName') || type === '' || (isCourier && !filled('courierCode'))

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const body: VendorCreateBody = {
        type: type as VendorCreateBody['type'],
        displayName: f('displayName').trim(),
        ...(isCourier && f('courierCode').trim() !== '' ? { courierCode: f('courierCode').trim() } : {}),
        ...(isCourier && f('integrationMode') !== ''
          ? { integrationMode: f('integrationMode') as 'WEBHOOK' | 'BATCH' }
          : {}),
      }
      const result = await createVendor(client, body, newIdempotencyKey())
      onOpenChange(false)
      onCreated()
      toast(result.deduped ? `${body.displayName} was already added` : `${body.displayName} added`)
    }, 'Failed to add the vendor.')
  }

  const noun = fixedType === 'COURIER' ? 'courier' : 'vendor'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add {noun}</DialogTitle>
          <DialogDescription>
            {fixedType === 'COURIER'
              ? 'A delivery partner. The courier code is what the courier-status upload matches its rows on.'
              : 'A manufacturer, print vendor or courier. Suspending and editing are separate actions.'}
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-3">
          {fixedType === undefined && (
            <Field label="Type" htmlFor="vndr-type">
              <Select id="vndr-type" value={f('type')} onChange={set('type')}>
                <option value="">Select a type</option>
                {VENDOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Display name" htmlFor="vndr-name">
            <Input id="vndr-name" value={f('displayName')} onChange={set('displayName')} />
          </Field>

          {isCourier && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Courier code" htmlFor="vndr-code" hint="Unique across vendors.">
                <Input id="vndr-code" value={f('courierCode')} onChange={set('courierCode')} />
              </Field>
              <Field label="Integration mode" htmlFor="vndr-mode" hint="Optional.">
                <Select
                  id="vndr-mode"
                  value={f('integrationMode')}
                  onChange={(e) => {
                    setValue('integrationMode', e.target.value)
                  }}
                >
                  <option value="">Not set</option>
                  {INTEGRATION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={incomplete} loading={saving}>
            Add {noun}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
