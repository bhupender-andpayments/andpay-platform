// Task 7: the batch-scoped compact upload flows Task 8 mounts inside the
// batch detail page's Next step card. Same three ingest routes the full-page
// flows under /uploads/* already use, but deliberately compact: a
// FileDropZone, a count summary, PerRowErrors for invalid rows, and a link to
// the matching full page for the DataGrid of preview rows this card omits on
// purpose. The full pages remain the deep-inspection surface; this card is
// the fast path from a batch's own Next step.
//
// Return, courier-status and activation each already have a full page (see
// features/uploads/*UploadPage.tsx). This one component switches on `kind`
// rather than being three components, because the state shape (file, preview,
// result, error, busy) and the FileDropZone-then-commit flow are identical
// across the three; only the endpoint, the extra courier picker, and the
// result shape differ.
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FileDropZone } from './FileDropZone.js'
import { SearchSelect } from './Picker.js'
import { PerRowErrors } from './PerRowErrors.js'
import { ErrorNote, InfoNote } from '../ui/primitives.js'
import { useAuth } from '../auth/AuthContext.js'
import { newIdempotencyKey } from '../api/idempotency.js'
import {
  uploadFileRejection,
  previewReturnUpload,
  commitReturnUpload,
  commitCourierStatus,
  commitActivationFile,
  getVendors,
  type ReturnPreviewResult,
  type ReturnCommitResult,
  type CourierStatusUploadResult,
  type ActivationUploadResult,
  type VendorRow,
} from '../api/endpoints.js'

export type EmbeddedUploadKind = 'return' | 'courier-status' | 'activation'

const FULL_PAGE_PATH: Record<EmbeddedUploadKind, string> = {
  return: '/uploads/return',
  'courier-status': '/uploads/courier-status',
  activation: '/uploads/activation',
}

// Mirrors ActivationUploadPage's outcomeLabel: the CWD reports every row, and
// three of the four outcomes are not errors, so each gets operator-facing
// words rather than the domain's own reason code.
function outcomeLabel(row: { activated: boolean; reason: string | null }): string {
  if (row.activated) return 'Activated'
  switch (row.reason) {
    case 'already-activated':
      return 'Already activated'
    case 'unknown-device':
      return 'Device not recognised'
    case 'unknown-dispatch':
      return 'Dispatch not found'
    case 'not-activatable':
      return 'Collateral does not activate'
    default:
      return row.reason ?? 'Not activated'
  }
}

export function EmbeddedUploadCard({
  kind,
  batchId: _batchId,
  batchAsgnIds,
  onDone,
}: {
  kind: EmbeddedUploadKind
  // Unused directly (the count comes from batchAsgnIds), but kept on the
  // props contract per the brief so a caller does not have to derive it twice.
  batchId?: string
  batchAsgnIds?: ReadonlySet<string>
  onDone?: () => void
}) {
  const { client } = useAuth()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'previewing' | 'committing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // return-only
  const [preview, setPreview] = useState<ReturnPreviewResult | null>(null)
  const [returnResult, setReturnResult] = useState<ReturnCommitResult | null>(null)

  // courier-status-only
  const [couriers, setCouriers] = useState<VendorRow[]>([])
  const [courierVndrId, setCourierVndrId] = useState('')
  const [courierResult, setCourierResult] = useState<CourierStatusUploadResult | null>(null)

  // activation-only
  const [activationResult, setActivationResult] = useState<ActivationUploadResult | null>(null)

  useEffect(() => {
    if (kind !== 'courier-status') return
    let cancelled = false
    getVendors(client)
      .then((rows) => {
        if (!cancelled) setCouriers(rows.filter((r) => r.type === 'COURIER'))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client, kind])

  const done = returnResult !== null || courierResult !== null || activationResult !== null

  const resetOutcomes = useCallback((): void => {
    setPreview(null)
    setReturnResult(null)
    setCourierResult(null)
    setActivationResult(null)
  }, [])

  const handlePick = useCallback(
    async (picked: File | null): Promise<void> => {
      setError(null)
      setFile(null)
      resetOutcomes()
      if (picked === null) return
      const rejection = uploadFileRejection(picked)
      if (rejection !== null) {
        setError(rejection)
        return
      }
      // Only the return flow has a preview route: courier-status and
      // activation re-parse server-side on commit and have nothing to show
      // beforehand, same as their full pages.
      if (kind !== 'return') {
        setFile(picked)
        return
      }
      setBusy('previewing')
      try {
        const p = await previewReturnUpload(client, picked)
        setFile(picked)
        setPreview(p)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to read the return sheet.')
      } finally {
        setBusy(null)
      }
    },
    [client, kind, resetOutcomes],
  )

  const commit = useCallback(async (): Promise<void> => {
    if (file === null) return
    if (kind === 'courier-status' && courierVndrId === '') return
    setError(null)
    setBusy('committing')
    try {
      if (kind === 'return') {
        setReturnResult(await commitReturnUpload(client, file, newIdempotencyKey()))
      } else if (kind === 'courier-status') {
        setCourierResult(await commitCourierStatus(client, file, courierVndrId, newIdempotencyKey()))
      } else {
        setActivationResult(await commitActivationFile(client, file, newIdempotencyKey()))
      }
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload the file.')
    } finally {
      setBusy(null)
    }
  }, [client, file, kind, courierVndrId, onDone])

  const validRows = preview?.validRows ?? []
  const invalidRows = preview?.invalidRows ?? []
  const structural = preview?.structuralErrors ?? []
  const previewOk = kind !== 'return' || (preview !== null && structural.length === 0)

  // The batch-scope hint (step 3 of the brief): counted from the ALREADY
  // PREVIEWED rows against the batch's own dispatch ids, never a refetch.
  // Commit is never gated on this: the sheet may legitimately cover several
  // batches, so the hint is informational only.
  const targetingBatch =
    kind === 'return' && batchAsgnIds !== undefined && preview !== null
      ? validRows.filter((r) => batchAsgnIds.has(r.asgnId)).length
      : null

  const commitDisabled =
    busy !== null ||
    file === null ||
    (kind === 'return' && (!previewOk || validRows.length === 0)) ||
    (kind === 'courier-status' && courierVndrId === '')

  return (
    <div className="space-y-3">
      {!done && (
        <>
          {kind === 'courier-status' && (
            <div className="space-y-1">
              <label htmlFor="embedded-courier-vendor" className="text-xs font-medium text-muted-foreground">
                Courier
              </label>
              <SearchSelect
                id="embedded-courier-vendor"
                placeholder="Select a courier…"
                value={courierVndrId}
                onChange={setCourierVndrId}
                options={couriers.map((c) => ({ value: c.id, label: c.displayName }))}
              />
            </div>
          )}

          <FileDropZone
            id={`embedded-upload-${kind}`}
            file={file}
            onPick={(f) => {
              void handlePick(f)
            }}
            disabled={busy !== null}
          />

          {busy === 'previewing' && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Reading the file…
            </p>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {structural.length > 0 && (
            <ErrorNote>
              <p className="font-medium">This sheet could not be read.</p>
              <ul className="mt-1 space-y-1">
                {structural.map((se, i) => (
                  <li key={`${se.code}-${i}`}>{se.message}</li>
                ))}
              </ul>
            </ErrorNote>
          )}

          {kind === 'return' && preview !== null && structural.length === 0 && (
            <>
              <p className="text-sm font-medium">
                {validRows.length} row{validRows.length === 1 ? '' : 's'} ready
                {invalidRows.length > 0
                  ? `, ${invalidRows.length} invalid`
                  : ''}
              </p>
              {targetingBatch !== null && (
                <InfoNote>
                  {validRows.length} row{validRows.length === 1 ? '' : 's'} in this file, {targetingBatch} target this
                  batch. Commit is not limited to this batch: the file may cover several.
                </InfoNote>
              )}
              {invalidRows.length > 0 && <PerRowErrors result={{ invalid: invalidRows.length }} />}
            </>
          )}

          <Button
            type="button"
            onClick={() => {
              void commit()
            }}
            disabled={commitDisabled}
          >
            {busy === 'committing' && <Loader2 className="animate-spin" aria-hidden="true" />}
            Commit
          </Button>
        </>
      )}

      {returnResult !== null &&
        (returnResult.rejected !== undefined ? (
          <ErrorNote>Nothing was written: {returnResult.rejected}</ErrorNote>
        ) : returnResult.deduped ? (
          <InfoNote>This sheet was already processed. Nothing was paired twice.</InfoNote>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {returnResult.pairedUnitIds.length} device(s) paired, {returnResult.shptIds.length} shipment(s) created
            </p>
            {returnResult.quarantined > 0 && <PerRowErrors result={{ quarantined: returnResult.quarantined }} />}
          </div>
        ))}

      {courierResult !== null && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {courierResult.advanced} advanced, {courierResult.trailOnly} recorded only
          </p>
          {(courierResult.quarantined > 0 || courierResult.invalid > 0) && (
            <PerRowErrors result={{ quarantined: courierResult.quarantined, invalid: courierResult.invalid }} />
          )}
        </div>
      )}

      {activationResult !== null && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {activationResult.activated} activated, {activationResult.invalid} rejected
          </p>
          {activationResult.results.length > 0 && (
            <ul className="space-y-1 text-sm">
              {activationResult.results.map((r) => (
                <li key={r.deviceId} className={r.activated ? undefined : 'text-muted-foreground'}>
                  {r.deviceId}: {outcomeLabel(r)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Link to={FULL_PAGE_PATH[kind]} className="text-sm font-medium text-primary underline">
        Open full upload page
      </Link>
    </div>
  )
}
