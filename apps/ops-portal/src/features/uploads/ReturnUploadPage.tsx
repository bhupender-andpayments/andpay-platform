// The print vendor's return sheet, uploaded by an OPERATOR (D-25, 13 Aug 2026;
// escalation decided 2026-08-11). DEMO.md step 7.
//
// The flow this closes: a batch generates a dispatch workbook, we hand it to the
// print vendor, the vendor prints and packs and fills in Device ID and AWB, then
// emails the sheet back. BRD FR-05 para 322 makes the ops upload the Phase-1
// channel outright, so this page is not a workaround for a missing vendor login.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT ASK: which print vendor sent it. That is
// resolved server-side from the batch the dispatch ids belong to, because the
// platform bound that vendor itself when it handed the batch over, and an
// operator retyping it could only ever be wrong or malicious. A sheet spanning
// two vendors' batches is refused whole rather than attributed to one of them.
//
// The preview parses only. It is worth having anyway because the two ways this
// file usually fails are both visible before committing: the wrong workbook
// (structural errors), and rows the vendor left half-filled (per-row errors).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowRight, Download, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '../../components/FileDropZone.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { CodeChip, ErrorNote, InfoNote } from '../../ui/primitives.js'
import { useToast } from '../../ui/Toast.js'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  uploadFileRejection,
  previewReturnUpload,
  commitReturnUpload,
  getBatchDetail,
  getDevices,
  getVendors,
  type ReturnPreviewResult,
  type ReturnCommitResult,
} from '../../api/endpoints.js'
import { buildSampleReturnSheet } from './sampleReturnSheet.js'
import { saveBlob } from '../../lib/saveBlob.js'
import { kindBySlug, type StepKey } from './uploadKinds.js'
import { BackLink } from '../../ui/DetailFacts.js'
import { UploadHelperCards } from './UploadHelperCards.js'

const KIND = kindBySlug('return')!

type PreviewRow = ReturnPreviewResult['validRows'][number]

// Each whole-file refusal names the thing the operator can actually check. None
// of them is "invalid file": that would send someone back to a spreadsheet with
// no idea which part of it to look at.
const REJECTION_COPY: Record<NonNullable<ReturnCommitResult['rejected']>, string> = {
  schema_invalid:
    'The sheet was refused whole because at least one row is missing a required value. Every row needs a Dispatch ID and an AWB.',
  no_resolvable_dispatch:
    'None of the Dispatch IDs in this sheet belong to a batch here. Check the sheet came from a batch this system generated, and that the Dispatch ID column was not edited.',
  mixed_vendors:
    'This sheet spans batches handed to DIFFERENT print vendors, so there is no single vendor it can be attributed to. Split it into one file per batch and upload them separately.',
  batch_has_no_vendor:
    'The batch these dispatches belong to has no print vendor bound yet, so nothing has been handed over and a return is premature. Check the batch on Batches.',
  // The server-side half of the batch-scope promise this page makes in its own
  // subtitle. It fires when a row names a dispatch from another batch, or one
  // that belongs to no batch at all: on a batch-scoped upload the operator has
  // said which batch the sheet is about, so an unresolvable row is a wrong sheet
  // rather than a row to park in Queues.
  foreign_dispatch:
    'This sheet holds at least one Dispatch ID that does not belong to this batch, so nothing was written. Upload it from the batch it belongs to, or from Uploads if it spans several. Check the Dispatch ID column was not edited or pasted from another run.',
}

export function ReturnUploadPage() {
  const { client } = useAuth()
  const { toast } = useToast()
  const [searchParams] = useSearchParams()

  // SCOPED TO ONE BATCH, since 18 Aug 2026 (the user's explicit correction: a
  // return sheet upload reachable with no batch in hand can be matched against
  // nothing, so it is no longer offered that way). The only door in is now the
  // batch's own detail page, which carries its id here. An operator who still
  // reaches this URL directly (no `batch` param) keeps the old general
  // behaviour, so nothing that already worked breaks.
  const targetBatchId = searchParams.get('batch')
  const [targetAsgnIds, setTargetAsgnIds] = useState<ReadonlySet<string> | null>(null)
  const [targetLoadError, setTargetLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (targetBatchId === null) return
    let cancelled = false
    void getBatchDetail(client, targetBatchId)
      .then((detail) => {
        if (cancelled) return
        if (detail === null) {
          setTargetLoadError(`Batch ${targetBatchId} was not found.`)
          return
        }
        setTargetAsgnIds(new Set(detail.entries.map((e) => e.asgnId)))
      })
      .catch(() => {
        if (!cancelled) setTargetLoadError('Could not load this batch to check the file against.')
      })
    return () => {
      cancelled = true
    }
  }, [client, targetBatchId])

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ReturnPreviewResult | null>(null)
  const [result, setResult] = useState<ReturnCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'previewing' | 'committing' | null>(null)

  const structural = preview?.structuralErrors ?? []
  const validRows = preview?.validRows ?? []
  const invalidRows = preview?.invalidRows ?? []

  const handleFile = useCallback(
    async (picked: File | null): Promise<void> => {
      setError(null)
      setPreview(null)
      setResult(null)
      setFile(null)
      if (picked === null) return
      const rejection = uploadFileRejection(picked)
      if (rejection !== null) {
        setError(rejection)
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
    [client],
  )

  const commit = useCallback(async (): Promise<void> => {
    if (file === null) return
    setError(null)
    setBusy('committing')
    try {
      // The batch travels WITH the commit (19 Aug 2026). The preview check below
      // still runs and still blocks the button with row-level detail, but it is
      // now the convenience: the server is the guarantee.
      const r = await commitReturnUpload(client, file, newIdempotencyKey(), targetBatchId ?? undefined)
      setResult(r)
      if (r.rejected === undefined && !r.deduped && r.pairedUnitIds.length > 0) {
        toast(`${r.pairedUnitIds.length} device(s) paired, ${r.shptIds.length} shipment(s) created`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload the return sheet.')
    } finally {
      setBusy(null)
    }
    // targetBatchId IS a dependency: it decides whether the server enforces the
    // batch scope at all, so a stale closure here would silently commit an
    // unscoped upload from a scoped page.
  }, [client, file, toast, targetBatchId])

  // TESTING AID (see ./sampleReturnSheet.ts). Unlike the inventory and bank
  // samples this one cannot be conjured: a return sheet names dispatches that
  // must already exist, be batched, and still be awaiting their vendor, so the
  // live state IS the input. Four reads, then a pure build:
  //   batches   pick the newest with a bound print vendor (one batch only, or
  //             the file is refused whole as mixed_vendors)
  //   detail    its entries, which carry the real Dispatch IDs and the W-5
  //             group that decides whether a row may carry a serial
  //   devices   filtered to unpaired, so no row hits unit_already_paired
  //   vendors   an ACTIVE courier code, or the optional column is omitted
  //             entirely rather than guessed (an unknown code quarantines)
  // A failure here is reported inline, not as a downloaded file that fails on
  // upload, which is the whole point of the exercise.
  const [sampling, setSampling] = useState(false)
  const downloadSample = useCallback(async (): Promise<void> => {
    setError(null)
    setSampling(true)
    try {
      // A BATCH MUST BE IN HAND. It always is when this page is reached from a
      // batch's own detail page (`?batch=`), which is the only place the
      // control is offered from as of 18 Aug 2026.
      //
      // It used to fall back to selectSampleReturnBatch, which picked the
      // NEWEST batch with a bound vendor when none was named. That is what read
      // as "it downloads a random batch": an operator on the generic Uploads
      // entry point got a file for whichever batch happened to be newest, not
      // the one they had in mind, and nothing on screen said which. Guessing
      // silently is worse than not offering the shortcut.
      const batchId = targetBatchId
      if (batchId === null) {
        setError('Open this from a batch to build its return sheet, so the file is scoped to the batch you mean.')
        return
      }
      const [detail, devices, vendors] = await Promise.all([
        getBatchDetail(client, batchId),
        getDevices(client, 'IN_STOCK'),
        getVendors(client),
      ])
      const courier = vendors.find(
        (v) => v.type === 'COURIER' && v.status === 'ACTIVE' && v.courierCode !== null,
      )
      const outcome = buildSampleReturnSheet({
        batchId,
        entries: detail.entries,
        freeSerials: devices
          .filter((d) => d.asgnId === null && d.deviceSerial !== null)
          .map((d) => d.deviceSerial!),
        courierCode: courier?.courierCode ?? null,
      })
      if (!outcome.ok) {
        setError(outcome.problem)
        return
      }
      // TWO downloads, one per delivery group (18 Aug 2026): a real return
      // sheet arrives from the vendor as two files, and either one can be
      // absent (a batch with nothing left to ship in that group).
      const { soundbox, collateral } = outcome.file
      if (soundbox !== null) saveBlob(soundbox.filename, new Blob([soundbox.csv], { type: 'text/csv;charset=utf-8' }))
      if (collateral !== null) {
        saveBlob(collateral.filename, new Blob([collateral.csv], { type: 'text/csv;charset=utf-8' }))
      }
      const parts = [
        soundbox !== null ? `${soundbox.rows} soundbox` : null,
        collateral !== null ? `${collateral.rows} collateral` : null,
      ].filter((p): p is string => p !== null)
      toast(`Sample sheets downloaded: ${parts.join(', ')}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build a sample return sheet.')
    } finally {
      setSampling(false)
    }
    // targetBatchId IS a dependency (19 Aug 2026). It was missing, so the
    // callback captured whatever the FIRST render read from the query string:
    // navigating from the bare /uploads/return to /uploads/return?batch=... on a
    // mounted page left this closure holding null, and the shortcut answered
    // "open this from a batch" while the batch id was plainly in the URL.
  }, [client, toast, targetBatchId])

  const columns = useMemo<ReadonlyArray<GridColumn<PreviewRow>>>(
    () => [
      {
        key: 'asgnId',
        header: 'Dispatch ID',
        cell: (r) => <span className="font-mono text-xs">{r.asgnId}</span>,
        sortValue: (r) => r.asgnId,
      },
      {
        key: 'device',
        header: 'Device ID',
        // A blank Device ID is MEANINGFUL here, not missing: the row reports a
        // collateral-only parcel. Saying so beats an empty cell the operator
        // reads as the vendor having forgotten something.
        cell: (r) =>
          r.deviceSerial === undefined || r.deviceSerial === '' ? (
            <span className="text-xs text-muted-foreground">collateral only</span>
          ) : (
            <span className="num">{r.deviceSerial}</span>
          ),
        sortValue: (r) => r.deviceSerial ?? '',
      },
      { key: 'awb', header: 'AWB', cell: (r) => <CodeChip>{r.awb}</CodeChip>, sortValue: (r) => r.awb },
      {
        key: 'courier',
        header: 'Courier',
        cell: (r) => <span className="text-xs text-muted-foreground">{r.courierCode ?? '-'}</span>,
        sortValue: (r) => r.courierCode ?? '',
      },
    ],
    [],
  )

  const previewOk = preview !== null && structural.length === 0

  // THE MATCH CHECK. A Dispatch ID belongs to exactly one batch, so checking
  // every previewed row's asgn id against THIS batch's own entries is exactly
  // as strict as checking a Batch ID column would be, and it cannot be fooled
  // by a column the vendor edited or dropped: the id itself is the fact.
  const foreignRows =
    targetAsgnIds === null ? [] : validRows.filter((r) => !targetAsgnIds.has(r.asgnId))
  const batchMismatch = targetBatchId !== null && targetAsgnIds !== null && foreignRows.length > 0

  const step: StepKey = result !== null ? 'commit' : previewOk ? 'review' : 'upload'

  return (
    <div className="flex flex-col gap-6">
      {/* The step rail is gone (2026-08-14 ruling): the page itself shows what
          is possible next, and the rail restated it in a second visual system.
          The back link goes to the section whose data this upload feeds. */}
      <BackLink to={targetBatchId === null ? '/batches' : `/batches/${targetBatchId}`} label="Batches" />

      <Card>
        <CardHeader>
          <CardTitle>Print vendor return</CardTitle>
          <CardDescription>
            {targetBatchId === null ? (
              'The dispatch sheet we generated, back from the vendor with Device ID and AWB filled in. The vendor is resolved from the batch, so there is nothing to pick here.'
            ) : (
              <>
                For <CodeChip>{targetBatchId}</CodeChip> only. Every Dispatch ID in the file must belong to this
                batch; a row from any other batch refuses the whole sheet.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {result === null && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="return-sheet-file">Return sheet</Label>
                {/* Only with a batch in scope: without one this could only
                    guess which batch to build for. See downloadSample. */}
                {targetBatchId !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={sampling || busy !== null}
                    title="Downloads this batch's own dispatches still awaiting return, paired with real in-stock device serials and fresh AWBs, ready to upload as-is."
                    onClick={() => {
                      void downloadSample()
                    }}
                  >
                    {sampling ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-4" aria-hidden="true" />
                    )}{' '}
                    Auto-fill with real devices
                  </Button>
                )}
              </div>
              <FileDropZone
                id="return-sheet-file"
                file={file}
                onPick={(f) => {
                  void handleFile(f)
                }}
                disabled={busy !== null}
                expects={[...KIND.columns!]}
                done={result !== null}
              />
            </div>
          )}

          {busy === 'previewing' && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Reading the sheet…
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
              <p className="mt-2">
                Nothing was written. Expected columns: {KIND.columns!.join(', ')}. If you meant a different file, each
                kind has its own upload on{' '}
                <Link className="underline" to="/uploads">
                  Uploads
                </Link>
                .
              </p>
            </ErrorNote>
          )}

          {targetLoadError !== null && <ErrorNote>{targetLoadError}</ErrorNote>}

          {previewOk && result === null && batchMismatch && (
            <ErrorNote>
              <strong>
                {foreignRows.length} row{foreignRows.length === 1 ? '' : 's'} do{foreignRows.length === 1 ? 'es' : ''}{' '}
                not belong to {targetBatchId}.
              </strong>{' '}
              Nothing was written. This upload is scoped to this one batch, so a sheet naming any other batch's
              dispatches is refused whole rather than accepted in part.
            </ErrorNote>
          )}

          {previewOk && result === null && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">
                  {validRows.length} row{validRows.length === 1 ? '' : 's'} ready
                </p>
                {invalidRows.length > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[12px] font-medium text-amber-700">
                    {invalidRows.length} unreadable
                  </span>
                )}
              </div>

              {invalidRows.length > 0 && (
                <ErrorNote>
                  <strong>
                    {invalidRows.length} row{invalidRows.length === 1 ? '' : 's'} could not be read
                  </strong>{' '}
                  and will be refused with the file, because a return sheet is accepted whole:
                  <ul className="mt-1 space-y-1">
                    {invalidRows.slice(0, 8).map((r) => (
                      <li key={r.rowNo}>
                        Row {r.rowNo}: {r.message}
                      </li>
                    ))}
                  </ul>
                  {invalidRows.length > 8 && <p className="mt-1">and {invalidRows.length - 8} more.</p>}
                </ErrorNote>
              )}

              <div className="rounded-lg border">
                <DataGrid
                  columns={columns}
                  rows={validRows}
                  getRowKey={(r) => `${r.asgnId}-${r.awb}-${r.deviceSerial ?? 'collateral'}`}
                  pageSize={20}
                  searchPlaceholder="Search dispatch, device or AWB…"
                  emptyTitle="No readable rows"
                  maxBodyHeight="24rem"
                />
              </div>

              <p className="text-xs text-muted-foreground">
                Nothing has been written yet. The server re-parses the file when you upload.
              </p>

              <Button
                type="button"
                className="self-start"
                onClick={() => {
                  void commit()
                }}
                disabled={busy !== null || validRows.length === 0 || invalidRows.length > 0 || batchMismatch}
              >
                {busy === 'committing' && <Loader2 className="animate-spin" aria-hidden="true" />}
                Upload {validRows.length} row{validRows.length === 1 ? '' : 's'}
              </Button>
            </>
          )}

          {result !== null && (
            <div className="space-y-3">
              {result.rejected !== undefined ? (
                <ErrorNote>
                  <strong>Nothing was written.</strong> {REJECTION_COPY[result.rejected]}
                </ErrorNote>
              ) : result.deduped ? (
                <InfoNote>
                  <strong>This sheet was already processed.</strong> Nothing was paired twice. A return sheet is
                  recognised by its contents, so re-uploading the same file, or uploading one the vendor already
                  submitted, is always safe.
                </InfoNote>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[12px] font-medium text-emerald-700">
                      {result.pairedUnitIds.length} device(s) paired
                    </span>
                    <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[12px] font-medium text-sky-700">
                      {result.shptIds.length} shipment(s) created
                    </span>
                    {result.collateralLinked > 0 && (
                      <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[12px] font-medium text-sky-700">
                        {result.collateralLinked} collateral parcel(s) linked
                      </span>
                    )}
                    {result.quarantined > 0 && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[12px] font-medium text-amber-700">
                        {result.quarantined} held
                      </span>
                    )}
                  </div>

                  <InfoNote>
                    <strong>The parcels are now trackable.</strong> Each AWB moves along the delivery ladder as the
                    courier reports it, which is the{' '}
                    <Link className="underline" to="/uploads/courier-status">
                      courier status upload
                    </Link>
                    . Activation opens once a parcel is delivered.
                  </InfoNote>

                  {result.quarantined > 0 && (
                    <ErrorNote>
                      <strong>
                        {result.quarantined} row{result.quarantined === 1 ? '' : 's'} could not be applied
                      </strong>{' '}
                      and {result.quarantined === 1 ? 'is' : 'are'} waiting in{' '}
                      <Link className="underline" to="/queues/intake">
                        Queues
                      </Link>
                      . The usual causes are a Device ID that is not in stock, and a dispatch that already has a device
                      against it.
                    </ErrorNote>
                  )}
                </>
              )}

              {/* WHERE THE OPERATOR CAME FROM DECIDES WHERE THEY GO (19 Aug
                  2026). Arriving from a batch (`?batch=`) means the work in hand
                  is THAT batch: its rows have just been paired and it is the
                  thing they were looking at, so it is the primary action and the
                  dispatch list is the secondary one. Arriving from the Uploads
                  index means there is no batch in hand, so the list is all we can
                  honestly offer. Same rule the BackLink at the top follows. */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {targetBatchId !== null && (
                  <Button asChild>
                    <Link to={`/batches/${targetBatchId}`}>
                      Back to this batch
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline">
                  <Link to="/dispatches">
                    View dispatches
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setFile(null)
                    setPreview(null)
                    setResult(null)
                    setError(null)
                  }}
                >
                  Upload another sheet
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <UploadHelperCards kind={KIND} step={step} />
    </div>
  )
}
