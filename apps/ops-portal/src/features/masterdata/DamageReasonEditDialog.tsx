import { editDamageReason, type DamageReasonRow } from '../../api/endpoints.js'
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

// Edit a damage reason (POST /ops/damage-reasons/:id/edit), the last of the
// five Master Data tabs to gain edit (18 Aug 2026): the other four had a route
// already; this one needed a new backend route + service function first
// (services/tms/src/damage-reason.ts updateDamageReasonWithinTx), on existing
// columns only, no schema change.
//
// Active/inactive stays a separate deferred action, same posture as create.

export function DamageReasonEditDialog({
  reason,
  open,
  onOpenChange,
  onSaved,
}: {
  reason: DamageReasonRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, filled, saving, error, save } = useCreateDialog(open, () => ({
    code: reason.code,
    label: reason.label,
  }))

  const incomplete = !filled('code', 'label')

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const code = f('code').trim()
      const label = f('label').trim()
      const result = await editDamageReason(
        client,
        reason.id,
        {
          ...(code !== reason.code ? { code } : {}),
          ...(label !== reason.label ? { label } : {}),
        },
        newIdempotencyKey(),
      )
      onOpenChange(false)
      onSaved()
      toast(result.deduped ? `${label} was already saved` : `${label} updated`)
    }, 'Failed to save this damage reason.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit damage reason</DialogTitle>
          <DialogDescription>
            {reason.active ? 'Active' : 'Inactive'}. Activating or deactivating is a separate action.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-3">
          <Field label="Code" htmlFor="dr-edit-code" hint="A stable identifier. It does not change if the label is later reworded.">
            <Input id="dr-edit-code" value={f('code')} onChange={set('code')} />
          </Field>
          <Field label="Label" htmlFor="dr-edit-label" hint="The text operators read. Matched case- and spacing-insensitively.">
            <Input id="dr-edit-label" value={f('label')} onChange={set('label')} />
          </Field>
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
