// The bank request ingest, complete on one page: pick the file, read the
// server's per-row verdict, commit. BRD 5.1 FR-01, DEMO.md steps 1 to 4.
//
// RESTORED HERE 13 Aug 2026. This flow briefly lived as stages 1 and 2 of the
// Workflow workspace, which put the platform's FIRST door inside a screen about
// a batch that does not exist yet. It is an upload, it belongs with the uploads,
// and the Uploads index is now the catalogue of every file we ingest.
//
// THIS PAGE ENDS AT COMMIT, deliberately. Committed rows accumulate in the
// pending pool, and BATCHES are what mint Dispatch IDs and generate collateral,
// usually on a different day (lot size or max wait, BRD FR-03). So this page
// says where the rows WENT rather than pretending to finish the job, and the
// recent-batches panel at the top makes that concrete: an operator who just
// committed sees the queue their rows feed, and one who came back later sees
// what their earlier files became.
//
// Adapted from the pdf-generation branch to this branch's conventions in three
// places, all deliberate: the shared uploadFileRejection gate (which also closes
// the drag-drop file-type bypass), the shared upload rail every other upload
// page renders, and this branch's toast SCOPE RULE - transient success only,
// with everything an operator must act on staying inline as ErrorNote. The
// original's rich failure toasts are therefore inline notes here, which is where
// a reason the operator has to act on belongs anyway.

import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Check, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '../../components/FileDropZone.js'
import { PerRowErrors } from '../../components/PerRowErrors.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { ErrorNote, InfoNote, StatusPill } from '../../ui/primitives.js'
import { useToast } from '../../ui/Toast.js'
import { useAuth } from '../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import {
  uploadFileRejection,
  commitBank,
  previewBank,
  type BankCommitResult,
  type BankPreviewResult,
  type PreviewRowResult,
} from '../../api/endpoints.js'
import { kindBySlug, type StepKey } from './uploadKinds.js'
import { BackLink } from '../../ui/DetailFacts.js'
import { UploadHelperCards } from './UploadHelperCards.js'

const KIND = kindBySlug('bank')!

export function BankIngestPage() {
  const { client } = useAuth()
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<BankPreviewResult | null>(null)
  const [commitResult, setCommitResult] = useState<BankCommitResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'previewing' | 'committing' | null>(null)

  const rows = preview?.rows ?? []
  const validRows = useMemo(() => rows.filter((r) => r.valid), [rows])
  const invalidRows = useMemo(() => rows.filter((r) => !r.valid), [rows])
  const structural = preview?.structuralErrors ?? []
  const recognised = rows.length > 0 ? Object.keys(rows[0]!.row) : []

  const handleFile = useCallback(
    async (picked: File | null): Promise<void> => {
      setError(null)
      setPreview(null)
      setCommitResult(null)
      setFile(null)
      if (picked === null) return
      // One shared gate: wrong type OR too big, refused before any network call.
      const rejection = uploadFileRejection(picked)
      if (rejection !== null) {
        setError(rejection)
        return
      }
      setBusy('previewing')
      try {
        const result = await previewBank(client, picked)
        setFile(picked)
        setPreview(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to preview the bank request file.')
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
      const result = await commitBank(client, file, newIdempotencyKey())
      setCommitResult(result)
      // Toast only when something actually landed. Every failing outcome is
      // rendered inline below instead, where it stays put and names its cause.
      if (result.accepted > 0) {
        toast(`${result.accepted} row(s) committed and pooling toward the next batch`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit the bank request file.')
    } finally {
      setBusy(null)
    }
  }, [client, file, toast])

  const columns = useMemo<ReadonlyArray<GridColumn<PreviewRowResult>>>(
    () => [
      { key: 'row', header: 'Row', align: 'right', cell: (r) => <span className="num">{r.rowNo}</span>, sortValue: (r) => r.rowNo },
      {
        key: 'outcome',
        header: 'Outcome',
        cell: (r) => <StatusPill value={r.valid ? 'valid' : 'invalid'} />,
        sortValue: (r) => (r.valid ? 'valid' : 'invalid'),
      },
      { key: 'merchant', header: 'Merchant', cell: (r) => r.row.displayName, sortValue: (r) => r.row.displayName },
      {
        key: 'vpa',
        header: 'UPI ID',
        cell: (r) => <span className="font-mono text-xs">{r.row.vpaValue}</span>,
        sortValue: (r) => r.row.vpaValue,
      },
      {
        key: 'bank',
        header: 'Bank / branch',
        cell: (r) => `${r.row.bankReferenceCode} - ${r.row.branchCode}`,
        sortValue: (r) => r.row.bankReferenceCode,
      },
      {
        key: 'asks',
        header: 'Asks for',
        cell: (r) => {
          const parts: string[] = []
          if (r.row.standeeCount > 0) parts.push(`${r.row.standeeCount} standee`)
          if (r.row.stickerCount > 0) parts.push(`${r.row.stickerCount} sticker`)
          if (r.row.soundbox) parts.push('soundbox')
          return <span className="text-xs text-muted-foreground">{parts.join(', ') || 'nothing'}</span>
        },
      },
      {
        key: 'errors',
        header: 'Errors',
        cell: (r) => (
          <div className="flex flex-wrap gap-1">
            {r.errors.map((code) => (
              <StatusPill key={code} value={code} />
            ))}
          </div>
        ),
      },
    ],
    [],
  )

  // Derived, not a second state machine: a clean preview IS Review, a landed
  // commit IS Commit. Commit lives in the grid's own toolbar, so unlike the
  // damage page there is no separate confirm step to track.
  const previewOk = preview !== null && structural.length === 0
  const step: StepKey = commitResult !== null ? 'commit' : previewOk ? 'review' : 'upload'


  return (
    <div className="flex flex-col gap-6">
      {/* The step rail is gone (2026-08-14 ruling): the page itself shows what
          is possible next, and the rail restated it in a second visual system.
          Back to BATCHES, not Dispatches: a committed bank file lands in the
          pending pool, and the pool is what the operator goes to check next. */}
      <BackLink to="/batches" label="Batches" />

      <Card>
        <CardHeader>
          <CardTitle>Bank request upload</CardTitle>
          <CardDescription>
            Parsed on the server against the bank&apos;s known layout; nothing is written until you commit. Committed
            rows pool toward the next batch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bank-ingest-file">Bank request file</Label>
            <FileDropZone
              id="bank-ingest-file"
              file={file}
              onPick={(f) => {
                void handleFile(f)
              }}
              disabled={busy !== null}
              done={commitResult !== null}
            />
          </div>

          {busy === 'previewing' && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Reading the file…
            </p>
          )}

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {/* Verified against the real files: handing the device inventory
              workbook to this drop zone returns SIXTEEN missing_required_column
              errors, every message naming an internal canonical field. Two
              problems that creates. Every error shares `code`, so the siblings
              collide on one React key (hence the index in the key below). And
              the operator's actual mistake, picking the wrong file, is left for
              them to infer from a wall of field names they have never seen.
              When most of the layout is absent the honest reading is "wrong
              file", so say that first and put the field list behind a
              disclosure. */}
          {structural.length > 0 && (
            <ErrorNote>
              {structural.every((se) => se.code === 'missing_required_column') && structural.length > 3 ? (
                <>
                  <p className="font-medium">This does not look like a bank request file.</p>
                  <p className="mt-1">
                    {structural.length} of the columns a bank request file must have are missing, so it was not read and
                    nothing was written. Check you picked the right file: device inventory, print vendor returns, courier
                    status and damage reports each have their own upload on{' '}
                    <Link className="underline" to="/uploads">
                      Uploads
                    </Link>
                    .
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium">This file could not be read.</p>
                  <ul className="mt-1 space-y-1">
                    {structural.map((se, i) => (
                      <li key={`${se.code}-${i}`}>{se.message}</li>
                    ))}
                  </ul>
                </>
              )}
              {structural.length > 3 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-medium">Show the missing columns</summary>
                  <ul className="mt-1 space-y-1 text-sm">
                    {structural.map((se, i) => (
                      <li key={`${se.code}-${i}`}>{se.message}</li>
                    ))}
                  </ul>
                </details>
              )}
            </ErrorNote>
          )}

          {previewOk && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {invalidRows.length > 0 ? (
                  <ErrorNote>
                    <strong>{invalidRows.length} row(s) are blocked.</strong> These will not be committed. Fix them in
                    the source file and upload again.
                  </ErrorNote>
                ) : (
                  <InfoNote>
                    <strong>Nothing is blocked.</strong> All {rows.length} rows can be committed.
                  </InfoNote>
                )}
                <InfoNote>
                  <strong>{recognised.length} columns recognised</strong> against the bank&apos;s layout, so nothing
                  needed mapping by hand.
                </InfoNote>
              </div>

              <DataGrid
                columns={columns}
                rows={rows}
                pageSize={20}
                getRowKey={(r) => String(r.rowNo)}
                searchPlaceholder="Search merchant, UPI ID or bank code…"
                emptyTitle="No rows"
                // Commit sits in the grid's own toolbar so the decision and its
                // evidence share a screen; below a 340-row table it would sit
                // several screens under the summary it depends on.
                //
                // The badge REPORTS THE OUTCOME rather than the request
                // finishing. A hardcoded green "Committed" once appeared three
                // inches above a red box saying nothing was committed, because
                // green plus a tick is the strongest "all good" signal on the
                // page and it was firing on `commitResult !== null`.
                toolbarRight={
                  commitResult === null ? (
                    <Button
                      type="button"
                      onClick={() => {
                        void commit()
                      }}
                      disabled={busy !== null || validRows.length === 0}
                    >
                      {busy === 'committing' && <Loader2 className="animate-spin" aria-hidden="true" />}
                      Commit {validRows.length} row(s)
                    </Button>
                  ) : commitResult.accepted > 0 ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                      <Check className="size-3.5" aria-hidden="true" />
                      {commitResult.accepted} committed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      <AlertTriangle className="size-3.5" aria-hidden="true" />
                      {commitResult.quarantined > 0 ? 'Held for review, 0 committed' : 'Nothing committed'}
                    </span>
                  )
                }
              />
            </>
          )}

          {commitResult !== null && (
            <>
              <PerRowErrors result={commitResult} />
              {/* CONDITIONAL, and that is the whole point. This note used to
                  render on `commitResult !== null`, so a commit where every row
                  was held still announced "Done, the rows now pool toward a
                  batch" directly under a message saying nothing was committed.
                  Re-uploading the same file is a NORMAL operator action, so that
                  contradiction sat on the most travelled path. A results panel
                  that says "done" has to have something to be done about. */}
              {commitResult.accepted > 0 ? (
                <InfoNote>
                  <strong>{commitResult.accepted} row(s) now pool toward a batch.</strong> When one triggers (lot size,
                  max wait, or a manual trigger on{' '}
                  <Link className="underline" to="/batches">
                    Batches
                  </Link>
                  ), it mints a Dispatch ID per merchant, and the print PDFs are generated from that batch.
                </InfoNote>
              ) : (
                <ErrorNote>
                  <strong>Nothing entered the pool.</strong>{' '}
                  {commitResult.duplicateVpa > 0
                    ? `All ${commitResult.duplicateVpa} row(s) repeat a UPI ID already in the system, so every one was held in quarantine rather than committed. A returning UPI ID is often a genuine additional soundbox for a merchant we already have: accept it in Queues after a look.`
                    : commitResult.duplicate > 0
                      ? `All ${commitResult.duplicate} row(s) were already ingested from an earlier upload, so this file added nothing.`
                      : commitResult.quarantined > 0
                        ? `All ${commitResult.quarantined} row(s) were held for review. The counts above say why each one was held.`
                        : 'No row in this file was committed, so no batch will change and there is nothing to generate. The counts above say what happened to each row.'}{' '}
                  {commitResult.quarantined > 0 && (
                    <>
                      Held rows wait for you in{' '}
                      <Link className="underline" to="/queues/quarantine">
                        Queues
                      </Link>
                      ; accepting one there is what puts it in the pool.
                    </>
                  )}
                </ErrorNote>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button asChild variant="outline">
                  <Link to="/batches">
                    View batches
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setFile(null)
                    setPreview(null)
                    setCommitResult(null)
                    setError(null)
                  }}
                >
                  Upload another file
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <UploadHelperCards kind={KIND} step={step} />
    </div>
  )
}
