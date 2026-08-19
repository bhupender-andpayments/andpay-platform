import { useEffect, useState } from 'react'
import {
  editBankMaster,
  uploadBankMasterLogo,
  getBankMasterLogoVersions,
  fetchBankMasterLogoDerivative,
  type BankMasterEditBody,
  type BankMasterRow,
  type BankLogoVersionRow,
} from '../../api/endpoints.js'
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

// The bank master detail dialog (Task 8, 2026-08-19): the pencil on the Bank
// Masters tab now opens THIS, not the old BankMasterEditDialog it replaces.
// One dialog, three sections: Details (the whole old edit form, plus the
// parent picker Task 7's hierarchy needs), Logo (the D.2 master/derivative
// pair upload and its version history), and Children (only on a top-level
// bank, listing its own children and an Add-child shortcut).
//
// THE BANK REFERENCE CODE IS NOT EDITABLE HERE, same as before: it is the
// immutable ingest resolver key and the edit route never accepts it.

const STATUSES = ['ACTIVE', 'SUSPENDED'] as const

export function BankMasterDetailDialog({
  bank,
  allRows,
  open,
  onOpenChange,
  onSaved,
  onAddChild,
}: {
  bank: BankMasterRow
  allRows: BankMasterRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  onAddChild: (parent: BankMasterRow) => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()

  // -- Details ---------------------------------------------------------- //

  const currentParentCode = allRows.find((r) => r.tnntId === bank.parentTnntId)?.bankReferenceCode ?? ''
  const hasChildren = allRows.some((r) => r.parentTnntId === bank.tnntId)
  const parentOptions = allRows.filter((r) => r.parentTnntId === null && r.tnntId !== bank.tnntId)

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
    parentBankReferenceCode: currentParentCode,
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
    ['parentBankReferenceCode', currentParentCode],
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

  // -- Logo --------------------------------------------------------------- //

  const [derivativeUrl, setDerivativeUrl] = useState<string | null>(null)
  const [versions, setVersions] = useState<BankLogoVersionRow[] | null>(null)
  const [masterFile, setMasterFile] = useState<File | null>(null)
  const [derivativeFile, setDerivativeFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let revoked: string | null = null
    fetchBankMasterLogoDerivative(bank.tnntId)
      .then((blob) => {
        if (blob === null) return
        revoked = URL.createObjectURL(blob)
        setDerivativeUrl(revoked)
      })
      .catch(() => setLogoError('Failed to load the current logo.'))
    getBankMasterLogoVersions(client, bank.tnntId)
      .then(setVersions)
      .catch(() => setVersions([]))
    return () => {
      if (revoked !== null) URL.revokeObjectURL(revoked)
    }
  }, [open, bank.tnntId, client])

  async function uploadLogo(): Promise<void> {
    if (masterFile === null || derivativeFile === null) return
    setUploading(true)
    setLogoError(null)
    try {
      await uploadBankMasterLogo(client, bank.tnntId, masterFile, derivativeFile, newIdempotencyKey())
      toast(`${bank.displayName} logo updated`)
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Failed to upload the logo.')
    } finally {
      setUploading(false)
    }
  }

  // -- Children ------------------------------------------------------------ //

  const isTopLevel = bank.parentTnntId === null
  const children = allRows.filter((r) => r.parentTnntId === bank.tnntId)

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
              <Field
                label="Parent bank"
                htmlFor="bm-detail-parent"
                hint={
                  hasChildren
                    ? 'This bank has child banks and cannot itself become a child.'
                    : 'One level only. Clearing makes this a top-level bank.'
                }
              >
                <Select
                  id="bm-detail-parent"
                  value={f('parentBankReferenceCode')}
                  onChange={(e) => setValue('parentBankReferenceCode', e.target.value)}
                  disabled={hasChildren}
                >
                  <option value="">None (top-level bank)</option>
                  {parentOptions.map((p) => (
                    <option key={p.tnntId} value={p.bankReferenceCode}>
                      {p.displayName} ({p.bankReferenceCode})
                    </option>
                  ))}
                </Select>
              </Field>
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
            {logoError !== null && <ErrorNote>{logoError}</ErrorNote>}
            {derivativeUrl !== null ? (
              <img src={derivativeUrl} alt={`${bank.displayName} logo`} className="max-h-16" />
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
                  {[...versions].reverse().map((v) => (
                    <li key={v.version}>
                      v{v.version} {v.filename}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {isTopLevel && (
            <div className="space-y-3 border-t pt-4">
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-foreground">Children</h3>
              {children.length === 0 ? (
                <p className="text-sm text-muted-foreground">No child banks.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {children.map((c) => (
                    <li key={c.tnntId}>
                      {c.displayName} ({c.bankReferenceCode}) {c.status}
                    </li>
                  ))}
                </ul>
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  onAddChild(bank)
                  onOpenChange(false)
                }}
              >
                Add child bank
              </Button>
            </div>
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
