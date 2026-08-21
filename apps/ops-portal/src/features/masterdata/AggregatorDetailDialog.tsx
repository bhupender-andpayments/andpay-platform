import { useEffect, useRef, useState } from 'react'
import {
  editAggregator,
  uploadAggregatorLogo,
  getAggregatorLogoVersions,
  getAggregatorLogoCurrent,
  fetchAggregatorLogoDerivative,
  fetchAggregatorLogoVersionMaster,
  type AggregatorEditBody,
  type AggregatorRow,
  type BankLogoVersionRow,
  type AggregatorLogoCurrent,
} from '../../api/endpoints.js'
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
import { invalidateLogoThumb } from './AggregatorLogoThumb.js'
import { blobToDataUrl } from '../../lib/blob.js'
import { rasterizeAiFile, derivativeFileFor } from '../../lib/ai-preview.js'

// The aggregator detail dialog (Task 8, 2026-08-20): the pencil on an
// aggregator row opens this. Two sections: Details (name, status, the
// aggregator code with its lock rule, and the optional D.1 fields) and Logo
// (the D.2 master/derivative pair upload and its version history), both
// re-pointed at the aggregator client functions and this row's own aggrId.
//
// THE AGGREGATOR CODE IS EDITABLE ONLY UNTIL `codeLocked`: once an ingest file
// has matched on it, the code becomes the resolver key for every future file
// and changing it here would silently orphan the ones already matched.

const STATUSES = ['ACTIVE', 'SUSPENDED'] as const

export function AggregatorDetailDialog({
  aggregator,
  open,
  onOpenChange,
  onSaved,
}: {
  aggregator: AggregatorRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { client } = useAuth()
  const { toast } = useToast()

  // -- Details ---------------------------------------------------------- //

  const { f, set, setValue, filled, saving, error, save } = useCreateDialog(open, () => ({
    displayName: aggregator.displayName,
    aggregatorCode: aggregator.aggregatorCode,
    address1: aggregator.address1 ?? '',
    address2: aggregator.address2 ?? '',
    address3: aggregator.address3 ?? '',
    city: aggregator.city ?? '',
    district: aggregator.district ?? '',
    country: aggregator.country ?? '',
    pin: aggregator.pin ?? '',
    mobile: aggregator.mobile ?? '',
    email: aggregator.email ?? '',
    status: aggregator.status,
  }))

  const incomplete = !filled('displayName', 'aggregatorCode')
  // Folds the optional block only while it is genuinely empty; one typed
  // character anywhere keeps it open.
  const hasAnyContact = (
    ['address1', 'address2', 'address3', 'city', 'district', 'country', 'pin', 'mobile', 'email'] as const
  ).some((k) => f(k).trim() !== '')

  // Only fields the operator actually changed go on the wire: editAggregator
  // is a partial COALESCE update, and sending every field back unconditionally
  // would work too, but this keeps the request an honest diff of the edit.
  const FIELDS: ReadonlyArray<[keyof AggregatorEditBody, string]> = [
    ['displayName', aggregator.displayName],
    ['aggregatorCode', aggregator.aggregatorCode],
    ['address1', aggregator.address1 ?? ''],
    ['address2', aggregator.address2 ?? ''],
    ['address3', aggregator.address3 ?? ''],
    ['city', aggregator.city ?? ''],
    ['district', aggregator.district ?? ''],
    ['country', aggregator.country ?? ''],
    ['pin', aggregator.pin ?? ''],
    ['mobile', aggregator.mobile ?? ''],
    ['email', aggregator.email ?? ''],
    ['status', aggregator.status],
  ]

  async function submit(): Promise<void> {
    if (incomplete) return
    await save(async () => {
      const body: AggregatorEditBody = {}
      for (const [key, original] of FIELDS) {
        const value = f(key).trim()
        if (value !== original) body[key] = value
      }
      const result = await editAggregator(client, aggregator.aggrId, body, newIdempotencyKey())
      onOpenChange(false)
      onSaved()
      toast(
        result.deduped
          ? `${aggregator.displayName} was already saved`
          : `${aggregator.displayName} updated (${result.changedFields.length} field${result.changedFields.length === 1 ? '' : 's'})`,
      )
    }, 'Failed to save this aggregator.')
  }

  // -- Logo --------------------------------------------------------------- //

  const [derivativeUrl, setDerivativeUrl] = useState<string | null>(null)
  const [versions, setVersions] = useState<BankLogoVersionRow[] | null>(null)
  // The names of what is stored right now, shown beside each file input so an
  // operator sees what is already chosen before replacing it. The derivative
  // runs its own version sequence, so this cannot be read off `versions`.
  const [stored, setStored] = useState<AggregatorLogoCurrent | null>(null)
  // The click-to-enlarge popup over the CURRENT thumbnail.
  const [lightboxOpen, setLightboxOpen] = useState(false)
  // Redesign 21 Aug 2026 (mockup): the upload controls live behind an explicit
  // Replace button once a logo exists, and are open from the start when none
  // does; the optional address/contact grid stays folded behind an Add link
  // until it holds a value. UI state only; every field and endpoint is the
  // same as before the redesign.
  const [replacing, setReplacing] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [masterFile, setMasterFile] = useState<File | null>(null)
  const [derivativeFile, setDerivativeFile] = useState<File | null>(null)
  // The data: URL preview of the PENDING pair, shown beside the current logo
  // BEFORE anything is uploaded, so the operator sees what they picked.
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  // True while the picked .ai is being drawn in the browser.
  const [rendering, setRendering] = useState(false)
  // Non-null once a picked .ai could not be rendered (saved without PDF
  // compatibility); the manual PNG/SVG input is then the way through.
  const [renderHint, setRenderHint] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  // The version-history preview: which token the operator clicked, and what
  // came back for it (a data: URL, 'loading', or 'none' for a 404).
  const [viewedVersion, setViewedVersion] = useState<string | null>(null)
  const [versionPreview, setVersionPreview] = useState<string | 'loading' | 'none' | null>(null)
  // Remount key for the two native file inputs: clearing React state after a
  // successful upload does not clear an uncontrolled input's shown filename.
  const [inputEpoch, setInputEpoch] = useState(0)
  // Bumps on every file pick; an async rasterize or preview result only lands
  // if its token is still current, so a stale render can never clobber a file
  // the operator picked afterwards.
  const pickSeq = useRef(0)

  function loadCurrent(): void {
    fetchAggregatorLogoDerivative(client, aggregator.aggrId)
      .then((blob) => {
        if (blob === null) return
        // The portal CSP is img-src 'self' data:, which blocks a blob: URL, so
        // the preview must be a data: URL, not URL.createObjectURL's output.
        return blobToDataUrl(blob).then(setDerivativeUrl)
      })
      .catch(() => setLogoError('Failed to load the current logo.'))
    getAggregatorLogoVersions(client, aggregator.aggrId)
      .then(setVersions)
      .catch(() => setVersions([]))
    getAggregatorLogoCurrent(client, aggregator.aggrId)
      .then(setStored)
      .catch(() => setStored(null))
  }

  useEffect(() => {
    if (!open) return
    loadCurrent()
  }, [open, aggregator.aggrId, client])

  async function pickMaster(file: File | null): Promise<void> {
    const token = ++pickSeq.current
    setMasterFile(file)
    setRenderHint(null)
    if (file === null) return
    setRendering(true)
    try {
      const { pngBlob, dataUrl } = await rasterizeAiFile(file)
      if (pickSeq.current !== token) return
      setDerivativeFile(derivativeFileFor(file.name, pngBlob))
      setPendingUrl(dataUrl)
    } catch {
      if (pickSeq.current !== token) return
      setRenderHint(
        'This .ai could not be rendered in the browser (it was likely saved without PDF compatibility). Attach a PNG or SVG derivative manually.',
      )
    } finally {
      if (pickSeq.current === token) setRendering(false)
    }
  }

  async function viewVersion(version: string): Promise<void> {
    if (viewedVersion === version) {
      // Second click on the same row folds the preview away.
      setViewedVersion(null)
      setVersionPreview(null)
      return
    }
    const token = ++pickSeq.current
    setViewedVersion(version)
    setVersionPreview('loading')
    try {
      const blob = await fetchAggregatorLogoVersionMaster(client, aggregator.aggrId, version)
      if (blob === null) {
        if (pickSeq.current === token) setVersionPreview('none')
        return
      }
      // The stored master is the .ai itself; render it in the browser the
      // same way a freshly picked file is previewed. A master saved without
      // PDF compatibility cannot be drawn, which reads as "no preview".
      const { dataUrl } = await rasterizeAiFile(new File([blob], `${version}.ai`, { type: 'application/pdf' }))
      // Only land if the operator has not clicked another row meanwhile.
      if (pickSeq.current === token) setVersionPreview(dataUrl)
    } catch {
      if (pickSeq.current === token) setVersionPreview('none')
    }
  }

  async function pickDerivative(file: File | null): Promise<void> {
    const token = ++pickSeq.current
    setDerivativeFile(file)
    if (file === null) return
    const url = await blobToDataUrl(file)
    if (pickSeq.current === token) setPendingUrl(url)
  }

  async function uploadLogo(): Promise<void> {
    if (masterFile === null || derivativeFile === null) return
    setUploading(true)
    setLogoError(null)
    try {
      await uploadAggregatorLogo(client, aggregator.aggrId, masterFile, derivativeFile, newIdempotencyKey())
      toast(`${aggregator.displayName} logo updated`)
      // Stay OPEN and refresh in place: the operator watches the current logo
      // and the version list flip to what they just uploaded, instead of the
      // dialog vanishing on them.
      pickSeq.current++
      setMasterFile(null)
      setDerivativeFile(null)
      setPendingUrl(null)
      setRenderHint(null)
      setViewedVersion(null)
      setVersionPreview(null)
      setInputEpoch((n) => n + 1)
      setReplacing(false)
      invalidateLogoThumb(aggregator.aggrId)
      loadCurrent()
      onSaved()
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Failed to upload the logo.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit aggregator</DialogTitle>
          <DialogDescription>{aggregator.displayName}</DialogDescription>
        </DialogHeader>
        {error !== null && <ErrorNote>{error}</ErrorNote>}

        <div className="space-y-6">
          {/* -- Identity ----------------------------------------------- */}
          <div className="space-y-4">
            <div className="grid grid-cols-[2fr_1fr] gap-3">
              <Field label="Display name" htmlFor="agg-detail-name">
                <Input id="agg-detail-name" value={f('displayName')} onChange={set('displayName')} />
              </Field>
              <Field label="Status" htmlFor="agg-detail-status">
                <Select
                  id="agg-detail-status"
                  value={f('status')}
                  onChange={(e) => {
                    setValue('status', e.target.value)
                  }}
                >
                  {STATUSES.map((st) => (
                    // Display prettified; the VALUE on the wire is unchanged.
                    <option key={st} value={st}>
                      {st.charAt(0) + st.slice(1).toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              label="Aggregator code"
              htmlFor="agg-detail-code"
              hint={
                aggregator.codeLocked
                  ? 'Locked: ingest has matched on this code.'
                  : "The code this bank appears in the tenant's request files. Editable until a first file matches it."
              }
            >
              <Input
                id="agg-detail-code"
                className="font-mono"
                value={f('aggregatorCode')}
                onChange={set('aggregatorCode')}
                disabled={aggregator.codeLocked}
              />
            </Field>
          </div>

          {/* -- Logo ---------------------------------------------------- */}
          <div className="space-y-3 border-t pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">Logo</h3>
                <p className="truncate text-xs text-muted-foreground">
                  {stored?.master != null ? (
                    <>
                      {stored.master.filename} · {stored.master.version}
                      {stored.derivative != null && (
                        <>
                          {' '}
                          {stored.derivative.filename === `${stored.master.filename.replace(/\.[^.]+$/, '')}.png`
                            ? '- PNG derivative generated automatically'
                            : `- derivative ${stored.derivative.filename} (${stored.derivative.version})`}
                        </>
                      )}
                    </>
                  ) : (
                    'No logo uploaded yet.'
                  )}
                </p>
              </div>
              {stored?.master != null && (
                <Button type="button" variant="secondary" size="sm" onClick={() => setReplacing((r) => !r)}>
                  {replacing ? 'Keep current' : 'Replace'}
                </Button>
              )}
            </div>
            {logoError !== null && <ErrorNote>{logoError}</ErrorNote>}

            {derivativeUrl !== null && (
              <div className="flex items-center gap-3 rounded-xl border p-3">
                <button
                  type="button"
                  className="block flex-none cursor-zoom-in"
                  aria-label="Preview the current logo"
                  title="Click to preview"
                  onClick={() => setLightboxOpen(true)}
                >
                  <img
                    src={derivativeUrl}
                    alt={`${aggregator.displayName} logo`}
                    className="h-12 w-12 rounded border border-border bg-white object-contain p-0.5"
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{stored?.master?.filename ?? 'Logo'}</p>
                  <p className="text-xs text-muted-foreground">
                    Master file{stored?.master != null && <> · {stored.master.version}</>}
                  </p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setLightboxOpen(true)}>
                  Preview
                </Button>
              </div>
            )}

            {/* The upload area: open from the start when nothing is stored,
                behind Replace once something is. Same fields, same flow. */}
            {(replacing || stored?.master == null) && (
              <div className="space-y-3 rounded-xl border border-dashed p-3">
                {(pendingUrl !== null || rendering) && (
                  <div className="flex items-start gap-6">
                    {derivativeUrl !== null && (
                      <div className="space-y-1">
                        <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">Current</p>
                        <img
                          src={derivativeUrl}
                          alt={`${aggregator.displayName} logo`}
                          className="max-h-24 rounded border border-border bg-white object-contain p-1"
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <p className="text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
                        New (not uploaded yet)
                      </p>
                      {rendering ? (
                        <p className="text-sm text-muted-foreground">Rendering the .ai…</p>
                      ) : (
                        <img
                          src={pendingUrl ?? undefined}
                          alt="Selected logo preview"
                          className="max-h-24 rounded border border-dashed border-border bg-white object-contain p-1"
                        />
                      )}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="Logo master (.ai)"
                    htmlFor="agg-logo-master"
                    hint="Pick the .ai; the preview and its PNG render derivative are generated right here in the browser."
                  >
                    <Input
                      id="agg-logo-master"
                      key={`master-${inputEpoch}`}
                      type="file"
                      accept=".ai,application/postscript,application/pdf"
                      onChange={(e) => void pickMaster(e.target.files?.[0] ?? null)}
                    />
                    {stored?.master != null && (
                      <p className="text-xs text-foreground">
                        Currently stored: <span className="font-medium">{stored.master.filename}</span> ({stored.master.version})
                      </p>
                    )}
                  </Field>
                  <Field
                    label="Render derivative (PNG or SVG)"
                    htmlFor="agg-logo-derivative"
                    hint={renderHint ?? 'Auto-generated from the .ai; pick one here only to override it.'}
                  >
                    <Input
                      id="agg-logo-derivative"
                      key={`derivative-${inputEpoch}`}
                      type="file"
                      accept="image/png,image/svg+xml"
                      onChange={(e) => void pickDerivative(e.target.files?.[0] ?? null)}
                    />
                    {stored?.derivative != null && (
                      <p className="text-xs text-foreground">
                        Currently stored: <span className="font-medium">{stored.derivative.filename}</span> ({stored.derivative.version})
                      </p>
                    )}
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
                        // AssetStore version tokens are already "v1", "v2", and so
                        // on: no extra "v" prefix here, or this reads "vv1".
                        <li key={v.version} className="space-y-1">
                          <button
                            type="button"
                            className="text-left text-primary hover:underline"
                            aria-label={`Preview logo version ${v.version}`}
                            onClick={() => void viewVersion(v.version)}
                          >
                            {v.version} {v.filename}
                          </button>
                          {viewedVersion === v.version &&
                            (versionPreview === 'loading' ? (
                              <p className="text-xs text-muted-foreground">Loading preview…</p>
                            ) : versionPreview === 'none' ? (
                              <p className="text-xs text-muted-foreground">No preview stored for this version.</p>
                            ) : versionPreview !== null ? (
                              <img
                                src={versionPreview}
                                alt={`Logo version ${v.version}`}
                                className="max-h-24 rounded border border-border bg-white object-contain p-1"
                              />
                            ) : null)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* -- Address and contact (all optional, folded while empty) --- */}
          <div className="border-t pt-4">
            {!contactOpen && !hasAnyContact ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed p-3.5">
                <div>
                  <p className="text-sm font-semibold">Address and contact</p>
                  <p className="text-xs text-muted-foreground">All optional. Nothing filled in yet.</p>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => setContactOpen(true)}>
                  Add
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Address and contact</h3>
                <Field label="Address 1" htmlFor="agg-detail-addr1" hint="Optional.">
                  <Input id="agg-detail-addr1" value={f('address1')} onChange={set('address1')} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Address 2" htmlFor="agg-detail-addr2" hint="Optional.">
                    <Input id="agg-detail-addr2" value={f('address2')} onChange={set('address2')} />
                  </Field>
                  <Field label="Address 3" htmlFor="agg-detail-addr3" hint="Optional.">
                    <Input id="agg-detail-addr3" value={f('address3')} onChange={set('address3')} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="City" htmlFor="agg-detail-city" hint="Optional.">
                    <Input id="agg-detail-city" value={f('city')} onChange={set('city')} />
                  </Field>
                  <Field label="District" htmlFor="agg-detail-district" hint="Optional.">
                    <Input id="agg-detail-district" value={f('district')} onChange={set('district')} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Country" htmlFor="agg-detail-country" hint="Optional.">
                    <Input id="agg-detail-country" value={f('country')} onChange={set('country')} />
                  </Field>
                  <Field label="PIN" htmlFor="agg-detail-pin" hint="Optional.">
                    <Input id="agg-detail-pin" value={f('pin')} onChange={set('pin')} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Mobile" htmlFor="agg-detail-mobile" hint="Optional. 10 digits.">
                    <Input id="agg-detail-mobile" value={f('mobile')} inputMode="numeric" maxLength={10} onChange={set('mobile')} />
                  </Field>
                  <Field label="Email" htmlFor="agg-detail-email" hint="Optional.">
                    <Input id="agg-detail-email" type="email" value={f('email')} onChange={set('email')} />
                  </Field>
                </div>
              </div>
            )}
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

        {/* The click-to-enlarge popup for the CURRENT logo. A nested dialog
            (radix stacks them) rather than a route or a new page: the point is
            only to showcase the stored artwork at a readable size. */}
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Current logo</DialogTitle>
              <DialogDescription>
                {stored?.derivative != null
                  ? `${stored.derivative.filename} (${stored.derivative.version})`
                  : aggregator.displayName}
              </DialogDescription>
            </DialogHeader>
            {derivativeUrl !== null && (
              <img
                src={derivativeUrl}
                alt={`${aggregator.displayName} logo, enlarged`}
                className="max-h-[65vh] w-full rounded border border-border bg-white object-contain p-2"
              />
            )}
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  )
}
