import { editVendor, type VendorRow } from '../../api/endpoints.js'
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

// Edit a vendor (POST /ops/vendors/:id/edit), the route that already existed
// and was never called from the portal (18 Aug 2026). Serves both master-data
// tabs, same as VendorCreateDialog: a courier IS a vendor row.
//
// TYPE AND STATUS ARE NOT HERE. The type is what the create door decides and
// the edit route does not accept it at all; status has its own separate
// deferred actions (suspend/activate), which this does not fold in. Only
// displayName and, for a courier, courierCode are editable.
//
// integrationMode is NOT edited here either, though the create dialog offers
// it: GET /ops/vendors never returns the current value (VendorRow has no such
// field), so there is nothing honest to seed the field with, and sending a
// blank choice would silently overwrite whatever is set today.

export function VendorEditDialog({
  vendor,
  open,
  onOpenChange,
  onSaved,
}: {
  vendor: VendorRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, filled, saving, error, save } = useCreateDialog(open, () => ({
    displayName: vendor.displayName,
    courierCode: vendor.courierCode ?? '',
  }))

  const isCourier = vendor.type === 'COURIER'
  const incomplete = !filled('displayName') || (isCourier && !filled('courierCode'))

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const displayName = f('displayName').trim()
      const courierCode = f('courierCode').trim()
      const result = await editVendor(
        client,
        vendor.id,
        {
          ...(displayName !== vendor.displayName ? { displayName } : {}),
          ...(isCourier && courierCode !== (vendor.courierCode ?? '') ? { courierCode } : {}),
        },
        newIdempotencyKey(),
      )
      onOpenChange(false)
      onSaved()
      toast(result.deduped ? `${displayName} was already saved` : `${displayName} updated`)
    }, 'Failed to save this vendor.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {vendor.type === 'COURIER' ? 'courier' : 'vendor'}</DialogTitle>
          <DialogDescription>{vendor.type} · {vendor.status}</DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-3">
          <Field label="Display name" htmlFor="vndr-edit-name">
            <Input id="vndr-edit-name" value={f('displayName')} onChange={set('displayName')} />
          </Field>

          {isCourier && (
            <Field label="Courier code" htmlFor="vndr-edit-code" hint="Unique across vendors.">
              <Input id="vndr-edit-code" value={f('courierCode')} onChange={set('courierCode')} />
            </Field>
          )}
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
