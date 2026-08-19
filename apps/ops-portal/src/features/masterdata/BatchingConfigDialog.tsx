import { useEffect, useState } from 'react'
import {
  getBankMasters,
  setBatchingConfig,
  type BankMasterRow,
  type BatchingConfigRow,
  type BatchingConfigSetBody,
} from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useAuth } from '../../auth/AuthContext.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, InfoNote, Input, Select } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useCreateDialog } from './useCreateDialog.js'

// Set a batching tier (POST /ops/batching-config, BRD 5.3.3).
//
// AN UPSERT, NOT AN APPEND, and the copy says so: writing a scope that already
// has a row REPLACES that tier's values rather than adding a second one. This
// is the one master-data write on this page that can change something already
// in effect, which is why it is worded "Set" throughout instead of "Add".
//
// WHICH TIER IS ADDRESSED IS IMPLIED BY WHICH FIELDS ARE PRESENT, not by a
// scope field on the body, so this dialog picks the tier explicitly and then
// SENDS ONLY that tier's fields. The domain refuses the combinations it cannot
// honour (upsertBatchingConfig, services/fulfillment/src/ops.ts):
//
//   programWire without tenantWire        -> there is no program-only scope
//   bankReferenceCode without tenantWire  -> bank codes are a tenant's own
//   bankReferenceCode with maxWaitSeconds -> R-7, a bank tier is min lot ONLY,
//                                            because the max-wait timer is armed
//                                            per pool and would never read it
//
// The form mirrors those rules rather than discovering them from a 400: the
// max-wait field is not rendered at all on the bank tier, and a tenant is
// required for the three narrower tiers. The server stays the authority.
//
// ADMIN-TIER: ops:batching-config-set sits in ADMIN_TIER_PERMISSIONS, so an
// operator on the baseline `ops` role gets a 403 here where the other three
// master-data creates succeed. That surfaces inline like any other server
// error; the button is NOT hidden by role, because the portal does not gate
// controls on role anywhere else and inventing that here would be a new pattern
// for one button.

type Tier = 'GLOBAL' | 'TENANT' | 'TENANT_PROGRAM' | 'BANK'

const TIERS: ReadonlyArray<{ value: Tier; label: string; hint: string }> = [
  { value: 'GLOBAL', label: 'Global', hint: 'The platform-wide default every pool falls back to.' },
  { value: 'TENANT', label: 'Tenant', hint: 'Overrides the global default for one bank partner.' },
  { value: 'TENANT_PROGRAM', label: 'Tenant and program', hint: 'The narrowest pool tier.' },
  { value: 'BANK', label: 'Bank (min lot only)', hint: 'A member-bank min-lot override, evaluated on its own pooled count.' },
]

// A positive integer, which is what the domain requires of the lot size.
function positiveInt(value: string): boolean {
  const trimmed = value.trim()
  return /^\d+$/.test(trimmed) && Number(trimmed) >= 1
}

/**
 * The max wait is entered in HOURS and sent in SECONDS.
 *
 * Hours is the unit the operators actually talk in ("hold a lot for two
 * hours"), and 7200 is a number nobody reads correctly at a glance. The wire
 * contract is unchanged: maxWaitSeconds is what the timer arms on, so the
 * conversion lives here at the edge of the form and nowhere else.
 *
 * Fractions are allowed because they already exist in the data (1800s is half
 * an hour), but the RESULT must land on a whole second, since that is what the
 * column stores. 0.25h is fine, 0.0001h is not.
 */
export function hoursToSeconds(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const seconds = Number(trimmed) * 3600
  if (!Number.isInteger(seconds) || seconds < 1) return null
  return seconds
}

/**
 * The inverse of hoursToSeconds, for seeding the hours field from a stored
 * row's seconds. Formats to at most 2 decimal places and trims a trailing
 * ".00"/".50"-style zero run, so 1800 seeds "0.5" rather than "0.5000...".
 */
function secondsToHours(seconds: number): string {
  return String(Math.round((seconds / 3600) * 100) / 100)
}

export function BatchingConfigDialog({
  open,
  onOpenChange,
  onCreated,
  existing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  /**
   * Edit mode (18 Aug 2026), seeded from a clicked row. Needs no new backend
   * work: the create route is already an upsert on (tenantWire, programWire,
   * bankReferenceCode), so an edit is just a re-post of that same scope's key
   * with new values. The scope itself is LOCKED while editing (the Scope
   * select below is disabled): changing which fields are present would target
   * a DIFFERENT upsert key and silently create a second row rather than
   * updating this one.
   */
  existing?: BatchingConfigRow
}) {
  const { client } = useAuth()
  const { toast } = useToast()
  const { f, set, setValue, saving, error, save } = useCreateDialog(
    open,
    existing === undefined
      ? undefined
      : () => ({
          tier: existing.scope,
          tenantWire: existing.tenantWire ?? '',
          programWire: existing.programWire ?? '',
          bankReferenceCode: existing.bankReferenceCode ?? '',
          minLotSize: String(existing.minLotSize),
          maxWaitHours: existing.maxWaitSeconds === null ? '' : secondsToHours(existing.maxWaitSeconds),
        }),
  )
  const [banks, setBanks] = useState<readonly BankMasterRow[]>([])

  // The tenant list is the bank-master list: a tenant IS a bank partner here.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getBankMasters(client)
      .then((rows) => {
        if (!cancelled) setBanks(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        if (!cancelled) setBanks([])
      })
    return () => {
      cancelled = true
    }
  }, [open, client])

  const tier = (f('tier') === '' ? 'GLOBAL' : f('tier')) as Tier
  const needsTenant = tier !== 'GLOBAL'
  const isBank = tier === 'BANK'
  const takesMaxWait = !isBank

  const incomplete =
    !positiveInt(f('minLotSize')) ||
    (needsTenant && f('tenantWire').trim() === '') ||
    (tier === 'TENANT_PROGRAM' && f('programWire').trim() === '') ||
    (isBank && f('bankReferenceCode').trim() === '') ||
    // Optional, but if typed it must be valid rather than silently dropped.
    (takesMaxWait && f('maxWaitHours').trim() !== '' && hoursToSeconds(f('maxWaitHours')) === null)

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      // ONLY this tier's fields. Sending an empty string for an unused field
      // would address a different tier than the operator chose.
      const body: BatchingConfigSetBody = {
        minLotSize: Number(f('minLotSize').trim()),
        ...(needsTenant ? { tenantWire: f('tenantWire').trim() } : {}),
        ...(tier === 'TENANT_PROGRAM' ? { programWire: f('programWire').trim() } : {}),
        ...(isBank ? { bankReferenceCode: f('bankReferenceCode').trim() } : {}),
        ...(takesMaxWait && f('maxWaitHours').trim() !== ''
          ? { maxWaitSeconds: hoursToSeconds(f('maxWaitHours')) as number }
          : {}),
      }
      const result = await setBatchingConfig(client, body, newIdempotencyKey())
      onOpenChange(false)
      onCreated()
      toast(
        result.deduped
          ? 'That batching tier was already set'
          : existing === undefined
            ? 'Batching tier set'
            : 'Batching tier updated',
      )
    }, existing === undefined ? 'Failed to set the batching tier.' : 'Failed to save this batching tier.')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing === undefined ? 'Set batching tier' : 'Edit batching tier'}</DialogTitle>
          <DialogDescription>
            {existing === undefined
              ? 'Minimum lot size and maximum wait, per scope. Setting a scope that already has a row replaces its values.'
              : 'The scope is fixed to what it already is; only its values change.'}
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-3">
          <Field label="Scope" htmlFor="bc-tier" hint={TIERS.find((t) => t.value === tier)?.hint}>
            <Select
              id="bc-tier"
              value={tier}
              disabled={existing !== undefined}
              onChange={(e) => {
                setValue('tier', e.target.value)
              }}
            >
              {TIERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          {needsTenant && (
            <Field label="Bank partner" htmlFor="bc-tenant">
              <Select
                id="bc-tenant"
                value={f('tenantWire')}
                disabled={existing !== undefined}
                onChange={(e) => {
                  setValue('tenantWire', e.target.value)
                }}
              >
                <option value="">Select a bank partner</option>
                {banks.map((b) => (
                  <option key={b.tnntId} value={b.tnntId}>
                    {b.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {tier === 'TENANT_PROGRAM' && (
            <Field
              label="Program ID"
              htmlFor="bc-program"
              hint="The prog_ id. There is no program master to pick from yet."
            >
              <Input id="bc-program" value={f('programWire')} onChange={set('programWire')} placeholder="prog_..." disabled={existing !== undefined} />
            </Field>
          )}

          {isBank && (
            <Field
              label="Member bank code"
              htmlFor="bc-bank"
              hint="The aggregator code as it appears on the partner's request file rows."
            >
              <Input id="bc-bank" value={f('bankReferenceCode')} onChange={set('bankReferenceCode')} disabled={existing !== undefined} />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum lot size" htmlFor="bc-min" hint="A whole number, 1 or more.">
              <Input id="bc-min" value={f('minLotSize')} inputMode="numeric" onChange={set('minLotSize')} />
            </Field>
            {takesMaxWait && (
              <Field label="Maximum wait (hours)" htmlFor="bc-wait" hint="Optional. Half hours are allowed, e.g. 1.5.">
                <Input id="bc-wait" value={f('maxWaitHours')} inputMode="decimal" onChange={set('maxWaitHours')} />
              </Field>
            )}
          </div>

          {isBank && (
            <InfoNote>
              A bank tier carries minimum lot size only. Maximum wait stays on the tenant and program tiers, where the
              timer that reads it is armed.
            </InfoNote>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={incomplete} loading={saving}>
            Set tier
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
