import { createAggregator, type AggregatorCreateBody, type BankMasterRow } from '../../api/endpoints.js'
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

// Add an aggregator under a tenant (POST /ops/bank-masters/:tnntId/aggregators,
// Task 8, 2026-08-20). An aggregator is the per-code row a tenant's own
// request files resolve against; a tenant needing more than one code (a
// default plus one or more member codes) gets one aggregator per code, all
// nested under the SAME tenant, rather than a second sibling tenant (the
// earlier parent/child tenant hierarchy this replaces).
//
// Only display name and aggregator code are required; every address and
// contact field is optional here, unlike the tenant create dialog's BRD D.1
// fields, and the server enforces nothing beyond what this form already
// asks for.

export function AggregatorCreateDialog({
  tenant,
  open,
  onOpenChange,
  onCreated,
}: {
  tenant: BankMasterRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, filled, saving, error, save } = useCreateDialog(open)

  const incomplete = !filled('displayName', 'aggregatorCode')

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const body: AggregatorCreateBody = {
        displayName: f('displayName').trim(),
        aggregatorCode: f('aggregatorCode').trim(),
        ...(f('address1').trim() !== '' ? { address1: f('address1').trim() } : {}),
        ...(f('address2').trim() !== '' ? { address2: f('address2').trim() } : {}),
        ...(f('address3').trim() !== '' ? { address3: f('address3').trim() } : {}),
        ...(f('city').trim() !== '' ? { city: f('city').trim() } : {}),
        ...(f('district').trim() !== '' ? { district: f('district').trim() } : {}),
        ...(f('country').trim() !== '' ? { country: f('country').trim() } : {}),
        ...(f('pin').trim() !== '' ? { pin: f('pin').trim() } : {}),
        ...(f('mobile').trim() !== '' ? { mobile: f('mobile').trim() } : {}),
        ...(f('email').trim() !== '' ? { email: f('email').trim() } : {}),
      }
      const result = await createAggregator(client, tenant.tnntId, body, newIdempotencyKey())
      onOpenChange(false)
      onCreated()
      toast(result.deduped ? `${body.displayName} was already added` : `${body.displayName} added`)
    }, 'Failed to add the aggregator.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add aggregator</DialogTitle>
          <DialogDescription>
            A new request-file code under <strong>{tenant.displayName}</strong>.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-4">
          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Identity</h3>
            <Field label="Display name" htmlFor="agg-name">
              <Input id="agg-name" value={f('displayName')} onChange={set('displayName')} />
            </Field>
            <Field
              label="Aggregator code"
              htmlFor="agg-code"
              hint="The code this bank appears as in the tenant's request files. Editable until a file first matches it."
            >
              <Input id="agg-code" value={f('aggregatorCode')} onChange={set('aggregatorCode')} />
            </Field>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Address (optional)</h3>
            <Field label="Address 1" htmlFor="agg-addr1" hint="Optional.">
              <Input id="agg-addr1" value={f('address1')} onChange={set('address1')} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Address 2" htmlFor="agg-addr2" hint="Optional.">
                <Input id="agg-addr2" value={f('address2')} onChange={set('address2')} />
              </Field>
              <Field label="Address 3" htmlFor="agg-addr3" hint="Optional.">
                <Input id="agg-addr3" value={f('address3')} onChange={set('address3')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City" htmlFor="agg-city" hint="Optional.">
                <Input id="agg-city" value={f('city')} onChange={set('city')} />
              </Field>
              <Field label="District" htmlFor="agg-district" hint="Optional.">
                <Input id="agg-district" value={f('district')} onChange={set('district')} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Country" htmlFor="agg-country" hint="Optional.">
                <Input id="agg-country" value={f('country')} onChange={set('country')} />
              </Field>
              <Field label="PIN" htmlFor="agg-pin" hint="Optional.">
                <Input id="agg-pin" value={f('pin')} onChange={set('pin')} />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Contact (optional)</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mobile" htmlFor="agg-mobile" hint="Optional. 10 digits.">
                <Input id="agg-mobile" value={f('mobile')} inputMode="numeric" maxLength={10} onChange={set('mobile')} />
              </Field>
              <Field label="Email" htmlFor="agg-email" hint="Optional.">
                <Input id="agg-email" type="email" value={f('email')} onChange={set('email')} />
              </Field>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={incomplete} loading={saving}>
            Add aggregator
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
