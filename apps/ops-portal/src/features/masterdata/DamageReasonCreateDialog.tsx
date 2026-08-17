import { createDamageReason, type DamageReasonCreateBody } from '../../api/endpoints.js'
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

// Add a damage reason (POST /ops/damage-reasons, BRD FR-08/FR-11).
//
// The two fields are NOT interchangeable, which is why both are asked for
// rather than one being derived from the other. `code` is a stable machine
// identifier an integration may reference, so it is deliberately never derived
// from the label and a later relabel does not change it. `label` is the human
// text the damage-file ingest matches on, case- and whitespace-insensitively,
// and it is unique on its NORMALIZED form: "battery issue" and "Battery Issue "
// are the same label, and the server refuses the second as a duplicate.
//
// Deactivating a reason is a separate action and stays deferred; a reason
// created here starts active.

export function DamageReasonCreateDialog({
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

  const incomplete = !filled('code', 'label')

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const body: DamageReasonCreateBody = {
        code: f('code').trim(),
        label: f('label').trim(),
      }
      const result = await createDamageReason(client, body, newIdempotencyKey())
      onOpenChange(false)
      onCreated()
      toast(result.deduped ? `${body.label} was already added` : `${body.label} added`)
    }, 'Failed to add the damage reason.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add damage reason</DialogTitle>
          <DialogDescription>
            The reason list an operator picks from when flagging a damaged dispatch.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-3">
          <Field label="Code" htmlFor="dr-code" hint="A stable identifier. It does not change if the label is later reworded.">
            <Input id="dr-code" value={f('code')} onChange={set('code')} />
          </Field>
          <Field label="Label" htmlFor="dr-label" hint="The text operators read. Matched case- and spacing-insensitively.">
            <Input id="dr-label" value={f('label')} onChange={set('label')} />
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={incomplete} loading={saving}>
            Add damage reason
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
