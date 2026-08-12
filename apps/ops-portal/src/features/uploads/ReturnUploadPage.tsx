// The print vendor's filled return sheet, uploaded by ops. BRD FR-05.
//
// Phase 1 is explicit in the BRD (para 322): the vendor emails the filled
// workbook and the AndPayments team uploads it. The sheet is the SAME workbook
// the batch page handed over, with Device ID and AWB filled in against each
// Dispatch ID; committing pairs each device to its dispatch, moves it PRINTED
// then DISPATCHED, and births one shipment per AWB at DISPATCHED_BY_VENDOR, which
// is exactly what the BRD names as the resulting status (para 332). The courier
// status file then moves shipments onward (In Transit and so on).
//
// The vendor identity is resolved SERVER-SIDE from the rows' batches
// (Batch.printVndr); nothing here ever states a vendor. Preview runs the same
// resolution dry, so a mixed or unbound batch is discovered before commit.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '../../components/FileDropZone.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { ErrorNote, InfoNote, StatusPill } from '../../ui/primitives.js'
import { useToast } from '../../ui/Toast.js'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  MAX_UPLOAD_BYTES,
  commitReturnUpload,
  getDispatches,
  previewReturnUpload,
  type DispatchRow,
  type ReturnCommitResult,
  type ReturnPreviewResult,
} from '../../api/endpoints.js'

/** What each quarantine code means and what to do about it, in operator words. */
const QUARANTINE_HINTS: Record<string, string> = {
  device_not_in_inventory: 'The Device ID was never uploaded as inventory. Load stock on Inventory, then re-upload.',
  unit_already_paired: 'That device is already paired to another dispatch. The vendor may have reused a serial.',
  invalid_asgn_id: 'The Dispatch ID is not a valid id. It must be copied unchanged from the sheet we sent.',
  asgn_not_found: 'No batched record carries that Dispatch ID. Check the sheet came from the right batch.',
  unknown_courier: 'The courier name did not match a registered courier. The row still paired; tracking is not bound.',
}

type PreviewRow = ReturnPreviewResult['validRows'][number] & { rowNo: number }

// `reloadToken` bumped by the parent after a successful commit, so this panel
// re-reads instead of sitting on the pre-commit snapshot. Without it, a commit
// wrote three real shipments, this panel kept showing "no shipments yet", and
// only a manual page reload made them appear: the API had refreshed, the UI
// had not, and the two disagreed on screen until the operator forced it.
function RecentDispatches({ reloadToken }: { reloadToken: number }) {
  const { client } = useAuth()
  const [rows, setRows] = useState<readonly DispatchRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getDispatches(client)
      .then((r) => {
        if (!cancelled) setRows(r.slice(0, 5))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load dispatches.')
      })
    return () => {
      cancelled = true
    }
  }, [client, reloadToken])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Recent dispatches</CardTitle>
            <CardDescription className="mt-1">
              Each committed row below becomes one of these: a shipment per AWB, born Dispatched by Vendor.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/dispatches">
              All dispatches
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error !== null ? (
          <ErrorNote>{error}</ErrorNote>
        ) : rows === null ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No shipments yet. The first committed return sheet creates them.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.awb}</span>
                <StatusPill value={d.status} />
                <span className="flex-none text-xs text-muted-foreground">{d.courierPartner ?? 'no courier'}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function ReturnUploadPage() {
  const { client } = useAuth()
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ReturnPreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<ReturnCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'previewing' | 'committing' | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  const previewRows = useMemo<readonly PreviewRow[]>(
    () => (preview?.validRows ?? []).map((r, i) => ({ ...r, rowNo: i + 1 })),
    [preview],
  )

  const handleFile = useCallback(
    async (picked: File | null): Promise<void> => {
      setError(null)
      setPreview(null)
      setCommitResult(null)
      setFile(null)
      if (picked === null) return
      if (picked.size > MAX_UPLOAD_BYTES) {
        setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
        return
      }
      setBusy('previewing')
      try {
        const result = await previewReturnUpload(client, picked)
        setFile(picked)
        setPreview(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to read the return sheet.')
      } finally {
        setBusy(null)
      }
    },
    [client],
  )

  const commit = useCallback(async (): Promise<void> => {
    if (file === null) return
    setError(null)
    setBusy('committing')
    try {
      const result = await commitReturnUpload(client, file, newIdempotencyKey())
      setCommitResult(result)
      if (result.deduped) {
        toast.show({
          tone: 'info',
          title: 'This exact file was already ingested',
          detail: 'Nothing changed. A corrected file with different content is treated as new.',
        })
      } else if (result.rejected !== undefined) {
        toast.show({ tone: 'error', title: 'The sheet was rejected', detail: `Reason: ${result.rejected}.` })
      } else {
        toast.show({
          tone: result.quarantined > 0 ? 'error' : 'ok',
          title: `${result.pairedUnitIds.length} device(s) paired, ${result.shptIds.length} shipment(s) created`,
          detail:
            result.quarantined > 0
              ? `${result.quarantined} row(s) were held back; the reasons are in Queues and summarised below.`
              : 'Every row paired. The shipments are live on Dispatches at Dispatched by Vendor.',
        })
        // New shipments actually exist now; make the panel above prove it
        // instead of leaving the operator to reload the page to see them.
        setReloadToken((n) => n + 1)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Failed to commit the return sheet.'
      setError(detail)
      toast.show({ tone: 'error', title: 'The commit failed', detail })
    } finally {
      setBusy(null)
    }
  }, [client, file, toast])

  const columns = useMemo<ReadonlyArray<GridColumn<PreviewRow>>>(
    () => [
      { key: 'row', header: 'Row', align: 'right', cell: (r) => <span className="num">{r.rowNo}</span>, sortValue: (r) => r.rowNo },
      { key: 'asgn', header: 'Dispatch ID', cell: (r) => <span className="font-mono text-xs">{r.asgnId}</span>, sortValue: (r) => r.asgnId },
      { key: 'device', header: 'Device ID', cell: (r) => <span className="font-mono text-xs">{r.deviceSerial}</span> },
      { key: 'awb', header: 'AWB', cell: (r) => <span className="font-mono text-xs">{r.awb}</span> },
      { key: 'courier', header: 'Courier', cell: (r) => r.courierCode ?? <span className="text-muted-foreground">-</span> },
    ],
    [],
  )

  const structural = preview?.structuralErrors ?? []
  const resolutionBlocked = preview !== null && structural.length === 0 && preview.resolutionError !== null

  return (
    <div className="flex flex-col gap-4">
      <RecentDispatches reloadToken={reloadToken} />

      <Card>
        <CardHeader>
          <CardTitle>Print vendor return sheet</CardTitle>
          <CardDescription>
            The dispatch sheet we sent, returned with Device ID and AWB filled in. Committing pairs each device to its
            Dispatch ID and creates the shipments. The print vendor is identified from the batch, never from the file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="return-file">Return sheet</Label>
            <FileDropZone
              id="return-file"
              file={file}
              onPick={(f) => {
                void handleFile(f)
              }}
              disabled={busy !== null}
              done={commitResult !== null}
            />
          </div>

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {structural.length > 0 && (
            <ErrorNote>
              <p className="font-medium">This file could not be read.</p>
              <ul className="mt-1 space-y-1">
                {structural.map((se) => (
                  <li key={se.code}>{se.message}</li>
                ))}
              </ul>
            </ErrorNote>
          )}

          {resolutionBlocked && <ErrorNote>{preview.resolutionError}</ErrorNote>}

          {preview !== null && structural.length === 0 && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {preview.resolvedVendor !== null && (
                  <InfoNote>
                    <strong>Every row resolves to {preview.resolvedVendor}.</strong> The sheet will be recorded as that
                    vendor&apos;s return.
                  </InfoNote>
                )}
                {preview.invalidRows.length > 0 ? (
                  <ErrorNote>
                    <strong>{preview.invalidRows.length} row(s) are incomplete</strong> (missing Dispatch ID, Device ID
                    or AWB) and will be skipped. Row numbers: {preview.invalidRows.map((r) => r.rowNo).join(', ')}.
                  </ErrorNote>
                ) : (
                  <InfoNote>
                    <strong>All {preview.validRows.length} row(s) carry the three required values.</strong>
                  </InfoNote>
                )}
              </div>

              <DataGrid
                columns={columns}
                rows={previewRows}
                pageSize={20}
                getRowKey={(r) => String(r.rowNo)}
                searchPlaceholder="Search Dispatch ID, Device ID or AWB..."
                emptyTitle="No usable rows"
                toolbarRight={
                  commitResult === null ? (
                    <Button
                      type="button"
                      onClick={() => {
                        void commit()
                      }}
                      disabled={busy !== null || previewRows.length === 0 || resolutionBlocked}
                    >
                      {busy === 'committing' && <Loader2 className="animate-spin" aria-hidden="true" />}
                      Commit {previewRows.length} row(s)
                    </Button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                      <Check className="size-3.5" aria-hidden="true" />
                      Committed
                    </span>
                  )
                }
              />
            </>
          )}

          {commitResult !== null && !commitResult.deduped && commitResult.rejected === undefined && (
            <div className="space-y-3">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border bg-muted/20 px-3.5 py-3 text-center">
                  <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Paired</dt>
                  <dd className="num mt-1 text-2xl font-semibold">{commitResult.pairedUnitIds.length}</dd>
                </div>
                <div className="rounded-xl border bg-muted/20 px-3.5 py-3 text-center">
                  <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Shipments</dt>
                  <dd className="num mt-1 text-2xl font-semibold">{commitResult.shptIds.length}</dd>
                </div>
                <div className="rounded-xl border bg-muted/20 px-3.5 py-3 text-center">
                  <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Held back</dt>
                  <dd className="num mt-1 text-2xl font-semibold">{commitResult.quarantined}</dd>
                </div>
              </dl>
              {commitResult.quarantined > 0 && (
                <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">What a held-back row means</p>
                  <ul className="mt-1.5 space-y-1">
                    {Object.entries(QUARANTINE_HINTS).map(([code, hint]) => (
                      <li key={code}>
                        <span className="font-mono text-[11px]">{code}</span>: {hint}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    The exact rows are in{' '}
                    <Link className="underline" to="/queues/intake">
                      Intake exceptions
                    </Link>
                    .
                  </p>
                </div>
              )}
              <InfoNote>
                <strong>Next: courier statuses.</strong> Shipments are at Dispatched by Vendor. The courier status file
                moves them to In Transit and onward; delivery is what unlocks activation.
              </InfoNote>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
