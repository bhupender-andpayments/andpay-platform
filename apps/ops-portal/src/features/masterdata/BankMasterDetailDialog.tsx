import { useEffect, useState } from 'react'
import {
  editBankMaster,
  uploadAggregatorLogo,
  getAggregatorLogoVersions,
  fetchAggregatorLogoDerivative,
  type BankMasterEditBody,
  type BankMasterRow,
  type BankLogoVersionRow,
} from '../../api/endpoints.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useAuth } from '../../auth/AuthContext.js'
import { useToast } from '../../ui/Toast.js'
import { Button, ErrorNote, Field, Input, Select, CodeChip, StatusPill } from '../../ui/primitives.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useCreateDialog } from './useCreateDialog.js'
import { blobToDataUrl } from '../../lib/blob.js'

// The tenant (bank master) detail dialog (Task 8, 2026-08-20 rework): the
// earlier parent-picker is gone along with the sibling-tenant hierarchy it
// edited. Three sections remain: Details (the tenant's own D.1 fields, no
// parent), Logo (the D.2 master/derivative pair upload and its version
// history, now targeting this tenant's DEFAULT aggregator rather than the
// tenant itself: the logo asset lives on the aggregator that ingest actually
// resolves files against), and Aggregators (the tenant's own aggregator list,
// default first, with an Add-aggregator shortcut).
//
// THE BANK REFERENCE CODE IS NOT EDITABLE HERE, same as before: it is the
// immutable ingest resolver key and the edit route never accepts it.

const STATUSES = ['ACTIVE', 'SUSPENDED'] as const

export function BankMasterDetailDialog({
  bank,
  open,
  onOpenChange,
  onSaved,
  onAddAggregator,
}: {
  bank: BankMasterRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onAddAggregator: (tenant: BankMasterRow) => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()

  // -- Details ---------------------------------------------------------- //

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

  // -- Logo (the tenant's DEFAULT aggregator) ------------------------------ //

  const defaultAggregator = bank.aggregators.find((a) => a.isDefault) ?? null

  const [derivativeUrl, setDerivativeUrl] = useState<string | null>(null)
  const [versions, setVersions] = useState<BankLogoVersionRow[] | null>(null)
  const [masterFile, setMasterFile] = useState<File | null>(null)
  const [derivativeFile, setDerivativeFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || defaultAggregator === null) return
    const aggrId = defaultAggregator.aggrId
    let cancelled = false
    fetchAggregatorLogoDerivative(aggrId)
      .then((blob) => {
        if (blob === null || cancelled) return
        // The portal CSP is img-src 'self' data:, which blocks a blob: URL, so
        // the preview must be a data: URL, not URL.createObjectURL's output.
        return blobToDataUrl(blob).then((url) => {
          if (!cancelled) setDerivativeUrl(url)
        })
      })
      .catch(() => setLogoError('Failed to load the current logo.'))
    getAggregatorLogoVersions(client, aggrId)
      .then(setVersions)
      .catch(() => setVersions([]))
    return () => {
      cancelled = true
    }
  }, [open, defaultAggregator, client])

  async function uploadLogo(): Promise<void> {
    if (masterFile === null || derivativeFile === null || defaultAggregator === null) return
    setUploading(true)
    setLogoError(null)
    try {
      await uploadAggregatorLogo(client, defaultAggregator.aggrId, masterFile, derivativeFile, newIdempotencyKey())
      toast(`${defaultAggregator.displayName} logo updated`)
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Failed to upload the logo.')
    } finally {
      setUploading(false)
    }
  }

  // -- Aggregators ---------------------------------------------------------- //

  const aggregators = [...bank.aggregators].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit bank master</DialogTitle>
          <DialogDescription>
            <CodeChip>{bank.bankReferenceCode}</CodeChip> is the ingest resolver key and cannot be changed here.
          </DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">Details</h3>
            <div className="space-y-3">
              <h4 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Identity</h4>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Display name" htmlFor="bm-detail-name">
                  <Input id="bm-detail-name" value={f('displayName')} onChange={set('displayName')} />
                </Field>
                <Field label="Status" htmlFor="bm-detail-status">
                  <Select
                    id="bm-detail-status"
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
              <h4 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Address</h4>
              <Field label="Address 1" htmlFor="bm-detail-addr1" hint="Optional.">
                <Input id="bm-detail-addr1" value={f('address1')} onChange={set('address1')} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Address 2" htmlFor="bm-detail-addr2" hint="Optional.">
                  <Input id="bm-detail-addr2" value={f('address2')} onChange={set('address2')} />
                </Field>
                <Field label="Address 3" htmlFor="bm-detail-addr3" hint="Optional.">
                  <Input id="bm-detail-addr3" value={f('address3')} onChange={set('address3')} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City" htmlFor="bm-detail-city" hint="Optional.">
                  <Input id="bm-detail-city" value={f('city')} onChange={set('city')} />
                </Field>
                <Field label="District" htmlFor="bm-detail-district" hint="Optional.">
                  <Input id="bm-detail-district" value={f('district')} onChange={set('district')} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Country" htmlFor="bm-detail-country" hint="Optional.">
                  <Input id="bm-detail-country" value={f('country')} onChange={set('country')} />
                </Field>
                <Field label="PIN" htmlFor="bm-detail-pin" hint="Optional.">
                  <Input id="bm-detail-pin" value={f('pin')} onChange={set('pin')} />
                </Field>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Contact</h4>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Mobile" htmlFor="bm-detail-mobile" hint="Optional. 10 digits.">
                  <Input id="bm-detail-mobile" value={f('mobile')} inputMode="numeric" maxLength={10} onChange={set('mobile')} />
                </Field>
                <Field label="Email" htmlFor="bm-detail-email" hint="Optional.">
                  <Input id="bm-detail-email" type="email" value={f('email')} onChange={set('email')} />
                </Field>
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">Logo</h3>
            {defaultAggregator === null ? (
              <p className="text-sm text-muted-foreground">No default aggregator.</p>
            ) : (
              <>
                {logoError !== null && <ErrorNote>{logoError}</ErrorNote>}
                {derivativeUrl !== null ? (
                  <img src={derivativeUrl} alt={`${defaultAggregator.displayName} logo`} className="max-h-16" />
                ) : (
                  <p className="text-sm text-muted-foreground">No logo uploaded yet.</p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Logo master (.ai)" htmlFor="bm-logo-master">
                    <Input
                      id="bm-logo-master"
                      type="file"
                      accept=".ai,application/postscript,application/pdf"
                      onChange={(e) => setMasterFile(e.target.files?.[0] ?? null)}
                    />
                  </Field>
                  <Field label="Render derivative (PNG or SVG)" htmlFor="bm-logo-derivative">
                    <Input
                      id="bm-logo-derivative"
                      type="file"
                      accept="image/png,image/svg+xml"
                      onChange={(e) => setDerivativeFile(e.target.files?.[0] ?? null)}
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void uploadLogo()}
                  disabled={masterFile === null || derivativeFile === null}
                  loading={uploading}
                >
                  Upload logo
                </Button>
                <div className="space-y-1">
                  {versions === null || versions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No versions yet.</p>
                  ) : (
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {/*
                        NO client-side reverse: services/fulfillment/src/storage/asset-store.ts
                        listVersions's own port contract is "All versions ever put()
                        for key, newest first", and getAggregatorLogoVersions maps
                        that straight through with no re-ordering. Wire order IS
                        display order here.
                      */}
                      {versions.map((v) => (
                        // AssetStore version tokens are already "v1", "v2", and
                        // so on: no extra "v" prefix here, or this reads "vv1".
                        <li key={v.version}>
                          {v.version} {v.filename}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="space-y-3 border-t pt-4">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">Aggregators</h3>
            {aggregators.length === 0 ? (
              <p className="text-sm text-muted-foreground">No aggregators.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {aggregators.map((a) => (
                  <li key={a.aggrId} className="flex items-center gap-2">
                    <CodeChip>{a.aggregatorCode}</CodeChip>
                    <span>{a.displayName}</span>
                    <StatusPill value={a.status} />
                    {a.isDefault && <CodeChip>default</CodeChip>}
                  </li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onAddAggregator(bank)
                onOpenChange(false)
              }}
            >
              Add aggregator
            </Button>
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
