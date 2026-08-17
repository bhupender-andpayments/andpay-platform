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
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { FileDropZone } from '../../components/FileDropZone.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { ErrorNote } from '../../ui/primitives.js'
import { pillClass, statusMeta } from '../../ui/format.js'
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
        toast(`${result.accepted} row(s) added and pooling toward the next batch`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit the bank request file.')
    } finally {
      setBusy(null)
    }
  }, [client, file, toast])

  // TWO TABLES, NO OUTCOME COLUMN (16 Aug 2026 team feedback: the single mixed
  // table behind a Valid/Invalid pill read as clutter). The category IS the
  // table now: clean rows sit under "Ready to add", failing rows under "Held
  // for review", so the pill column and the Errors column on clean rows both
  // had nothing left to say. The held table alone carries a Reason column.
  const baseColumns = useMemo<ReadonlyArray<GridColumn<PreviewRowResult>>>(
    () => [
      { key: 'row', header: '#', align: 'right', cell: (r) => <span className="num">{r.rowNo}</span>, sortValue: (r) => r.rowNo },
      { key: 'merchant', header: 'Merchant', cell: (r) => r.row.displayName, sortValue: (r) => r.row.displayName },
      {
        key: 'vpa',
        header: 'UPI ID',
        cell: (r) => <span className="font-mono text-xs">{r.row.vpaValue}</span>,
        sortValue: (r) => r.row.vpaValue,
      },
      // Bank and Branch as their own columns (16 Aug 2026 review): the joined
      // "3 - 7" cell made two facts unsortable and unsearchable as themselves.
      {
        key: 'bank',
        header: 'Bank',
        cell: (r) => r.row.bankReferenceCode,
        sortValue: (r) => r.row.bankReferenceCode,
      },
      {
        key: 'branch',
        header: 'Branch',
        cell: (r) => r.row.branchCode,
        sortValue: (r) => r.row.branchCode,
      },
    ],
    [],
  )

  const readyColumns = useMemo<ReadonlyArray<GridColumn<PreviewRowResult>>>(
    () => [
      ...baseColumns,
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
    ],
    [baseColumns],
  )

  const heldColumns = useMemo<ReadonlyArray<GridColumn<PreviewRowResult>>>(
    () => [
      ...baseColumns,
      {
        // AMBER, not the default pill. These codes are absent from STATUS_MAP,
        // so a plain StatusPill falls through to the neutral grey-blue that
        // reads as "no status" rather than "needs a look". `pending` is the
        // house amber and the only honest facet for a row awaiting a human.
        key: 'reason',
        header: 'Reason',
        cell: (r) => (
          <div className="flex flex-wrap gap-1">
            {r.errors.map((code) => (
              <span key={code} className={pillClass('pending')}>
                {statusMeta(code).label}
              </span>
            ))}
          </div>
        ),
      },
    ],
    [baseColumns],
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
            Parsed on the server against the bank&apos;s known layout; nothing is written until you add. Added rows
            pool toward the next batch.
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
                    nothing was written. Check you picked the right file: device inventory, print vendor returns and
                    courier status each have their own upload on{' '}
                    <Link className="underline" to="/uploads">
                      Uploads
                    </Link>
                    . Damage is not a file: flag it from the dispatch itself, on{' '}
                    <Link className="underline" to="/dispatches">
                      Dispatches
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
              {/* One muted sentence where two banner boxes used to sit. The
                  blocked-row count is the held table's own title now, and a
                  recognised-columns fact never deserved a colored box. */}
              <p className="-mt-1 text-xs text-muted-foreground">
                {recognised.length} columns recognised against the bank&apos;s layout; nothing needed mapping by hand.
              </p>

              {/* STACKED, full width, one panel per category (team decision,
                  17 Aug 2026, after trying side by side). Full width is what
                  buys the honest column set: Bank and Branch stay separate
                  rather than collapsing back into one cramped cell.
                  Discoverability of the second panel is handled by BOUNDING
                  each table's body instead of by column layout, so a long
                  file cannot push the held panel off the bottom of the world.

                  ONE HEADER ROW PER CARD, and the heading goes INSIDE the grid's
                  toolbar rather than in a strip above it. A separate <header>
                  meant the title, the column headers and the cells each started
                  at a different left edge, because the strip's padding and the
                  grid's own px-4 were not the same number. Sharing the toolbar
                  makes one left edge for all three, which is the whole visual
                  difference.

                  SURFACES STAY WHITE. Colour is spent only on the small icon
                  chip and the reason pills; the tinted header washes and the
                  red panel border are gone. Amber, not red, on the held side:
                  these rows are awaiting a human decision, not errors, and
                  amber is already what quarantined and flagged counts use. */}
              <div className="space-y-4">
                <section className="overflow-hidden rounded-lg border bg-card">
                  <div>
                    <DataGrid
                      columns={readyColumns}
                      rows={validRows}
                      pageSize={20}
                      // Bounded so the CARD ends: a long file scrolls inside
                      // its own panel instead of pushing the held panel and
                      // the actions below off screen.
                      maxBodyHeight="38vh"
                      getRowKey={(r) => String(r.rowNo)}
                      searchPlaceholder="Search merchant, UPI ID, bank or branch…"
                      emptyTitle="Nothing to add"
                      emptyMessage="No row in this file passed the checks. The held table says why, row by row."
                      // THE OUTCOME PILL BELONGS ON THE LEFT, beside the title it
                      // is about. It used to replace the Add button in
                      // toolbarRight, which read as a broken button sitting where
                      // an action had been, and wrapped "1 added" onto two lines
                      // in the narrow gap beside the search box. Here it has room,
                      // and nowrap guarantees it keeps it.
                      //
                      // It REPORTS THE OUTCOME rather than the request finishing:
                      // a hardcoded green "Committed" once appeared inches above a
                      // message saying nothing was committed.
                      toolbarLeft={
                        <>
                          <span className="flex size-6 items-center justify-center rounded-md bg-emerald-50 text-emerald-600">
                            <CheckCircle2 className="size-3.5" aria-hidden="true" />
                          </span>
                          <h3 className="text-sm font-semibold">Ready to add</h3>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                            {validRows.length}
                          </span>
                          {commitResult !== null &&
                            (commitResult.accepted > 0 ? (
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                                <Check className="size-3.5" aria-hidden="true" />
                                {commitResult.accepted} added
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                <AlertTriangle className="size-3.5" aria-hidden="true" />
                                {commitResult.quarantined > 0 ? 'Held for review, 0 added' : 'Nothing added'}
                              </span>
                            ))}
                        </>
                      }
                      // The action sits in the grid's own toolbar so the decision
                      // and its evidence share a screen; below a 340-row table it
                      // would sit several screens under the rows it depends on.
                      // Gone once committed, leaving the search box alone: there is
                      // no second Add to offer for a file already added.
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
                            Add {validRows.length} {validRows.length === 1 ? 'row' : 'rows'}
                          </Button>
                        ) : undefined
                      }
                    />
                  </div>
                </section>

                {invalidRows.length > 0 && (
                  <section className="overflow-hidden rounded-lg border bg-card">
                    <div>
                      <DataGrid
                        columns={heldColumns}
                        rows={invalidRows}
                        pageSize={20}
                        maxBodyHeight="38vh"
                        getRowKey={(r) => String(r.rowNo)}
                        searchPlaceholder="Search merchant, UPI ID, bank or branch…"
                        emptyTitle="Nothing held"
                        toolbarLeft={
                          <>
                            <span className="flex size-6 items-center justify-center rounded-md bg-amber-50 text-amber-700">
                              <AlertTriangle className="size-3.5" aria-hidden="true" />
                            </span>
                            <h3 className="text-sm font-semibold">
                              {commitResult === null ? 'Will be held for review' : 'Held for review'}
                            </h3>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                              {invalidRows.length}
                            </span>
                            <span className="hidden text-xs text-muted-foreground sm:inline">Accept in Queues to add</span>
                          </>
                        }
                      />
                    </div>
                  </section>
                )}
              </div>
            </>
          )}

          {commitResult !== null && (
            <>
              {/* BUTTONS ONLY under the tables (team decision, 17 Aug 2026).
                  The tally line and the notice sentences that used to sit here
                  are gone. What each table did is now said by its own header
                  pill and count, so the summary was restating the screen; the
                  pooling fact is said once by the success toast.

                  Deliberately dropped with them, and worth knowing: the
                  malformed-QR count (D-8) had no other surface in the portal,
                  so the "GSCB should still be told" number is no longer
                  reachable from the UI. Same for the accepted-repeat and
                  shared-mobile review signals (D-2). The commit response still
                  carries all three. */}

              {/* The agreed hierarchy (16 Aug 2026): the likely next action is
                  primary on the left, confirming the outcome is secondary
                  beside it, and the one thing needing ATTENTION, when it
                  exists, sits alone on the right in the red-tinted style. */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={() => {
                      setFile(null)
                      setPreview(null)
                      setCommitResult(null)
                      setError(null)
                    }}
                  >
                    Upload another file
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/batches">
                      Go to batches
                      <ArrowRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
                {commitResult.quarantined > 0 && (
                  <Button asChild variant="destructive">
                    <Link to="/queues/quarantine">Go to Quarantine</Link>
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <UploadHelperCards kind={KIND} step={step} />
    </div>
  )
}
