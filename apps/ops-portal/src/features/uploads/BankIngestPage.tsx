// The bank request ingest, complete on one page: pick the file, read the server's
// per-row verdict, commit. BRD 5.1 FR-01.
//
// THIS PAGE ENDS AT COMMIT, deliberately. It used to be step one of a six-step
// wizard that carried on into PDF generation, which misrepresented the platform:
// committed rows accumulate in the pending pool and BATCHES are what mint Dispatch
// IDs and generate collateral, usually on a different day (lot size or max wait,
// BRD FR-033). Generation therefore lives with the batch (/batches/:id/generate),
// and this page says where the rows went instead of pretending to finish the job.
//
// The recent-batches panel at the top is that statement made concrete: an operator
// who has just committed sees the queue their rows feed, and the one who came back
// later sees what their earlier files became.

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  MAX_UPLOAD_BYTES,
  commitBank,
  getBatches,
  previewBank,
  type BankCommitResult,
  type BankPreviewResult,
  type BatchRow,
  type PreviewRowResult,
} from '../../api/endpoints.js'

/**
 * Where committed rows GO, shown before the drop zone.
 *
 * Commit does not produce a file or a page; it feeds a pool that becomes a batch.
 * Without this panel that is invisible, and "did my upload do anything" gets asked
 * at exactly the moment the operator is looking at a page that ends quietly.
 */
function RecentBatches() {
  const { client } = useAuth()
  const [batches, setBatches] = useState<readonly BatchRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getBatches(client)
      .then((rows) => {
        if (!cancelled) setBatches(rows.slice(0, 5))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load batches.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Recent batches</CardTitle>
            <CardDescription className="mt-1">
              Committed rows pool up here; a batch mints the Dispatch IDs and is where collateral is generated.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/batches">
              All batches
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error !== null ? (
          <ErrorNote>{error}</ErrorNote>
        ) : batches === null ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading
          </div>
        ) : batches.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No batch has been formed yet. Committed rows wait in the pending pool until one triggers.
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {batches.map((b) => (
              <li key={b.id}>
                <Link
                  to={`/batches/${b.id}`}
                  className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.id}</span>
                  <span className="flex-none text-xs text-muted-foreground">{b.triggerReason}</span>
                  <span className="num flex-none text-xs">{b.unitCount} units</span>
                  <span className="flex-none text-xs text-muted-foreground">
                    {new Date(b.createdAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function BankIngestPage() {
  const { client } = useAuth()
  const toast = useToast()
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
      if (picked.size > MAX_UPLOAD_BYTES) {
        setError('File exceeds the 5 MiB upload limit. Split it into smaller files and try again.')
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

      // WHAT THE COMMIT ACTUALLY DID, said out loud, because these outcomes
      // decide whether the operator has anything left to do.
      //
      // Repeat UPI IDs are the loudest case. Ruled 2026-08-11: the repeat rows
      // are QUARANTINED, not accepted, so nothing repeats a VPA into a print
      // run without a human look. Resolving the quarantine (Queues) is how the
      // legitimate additional-soundbox order proceeds.
      if (result.accepted === 0) {
        // The REASON has to survive into this branch. It previously did not: the
        // duplicate-VPA message lived only in the `accepted > 0` branch, so the
        // commonest case of all (re-upload the same file, EVERY row repeats,
        // accepted is 0) got the one message that named no cause. "Nothing was
        // committed. Check the per-row outcomes" when the server knew exactly
        // which rule fired and how many times.
        const cause =
          result.duplicateVpa > 0
            ? `All ${result.duplicateVpa} row(s) repeat a UPI ID already in the system, so every one was held in quarantine instead of committed. ` +
              'If these are genuine additional soundbox orders, accept them in Queues.'
            : result.duplicate > 0
              ? `All ${result.duplicate} row(s) were already ingested from an earlier upload, so this file added nothing.`
              : result.quarantined > 0
                ? `All ${result.quarantined} row(s) were held for review. Open Queues to see the reason on each one.`
                : 'No row in this file was accepted. Check the per-row outcomes for the blocking reasons.'
        toast.show({ tone: 'error', title: 'Nothing was committed', detail: cause })
      } else if (result.duplicateVpa > 0) {
        toast.show({
          tone: 'error',
          title: `${result.duplicateVpa} row(s) carry a UPI ID already in the system`,
          detail:
            `${result.accepted} row(s) were committed; the repeats were QUARANTINED for review, not ingested. ` +
            'A returning UPI ID is often an additional soundbox for a merchant we already have: accept it from Queues after a look.',
        })
      } else {
        toast.show({
          tone: 'ok',
          title: `${result.accepted} row(s) committed`,
          detail:
            result.quarantined > 0
              ? `${result.quarantined} row(s) were quarantined and need a look in Queues.`
              : 'Every row was accepted. They pool toward the next batch, visible above.',
        })
      }
      if (result.duplicateMobile > 0) {
        toast.show({
          tone: 'info',
          title: `${result.duplicateMobile} row(s) share a mobile with a different merchant`,
          detail: 'One owner with two shops, a shared shopkeeper phone, or a typo. Worth a glance, not a blocker.',
        })
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Failed to commit the bank request file.'
      setError(detail)
      toast.show({ tone: 'error', title: 'The commit failed', detail })
    } finally {
      setBusy(null)
    }
  }, [client, file, toast])

  const columns = useMemo<ReadonlyArray<GridColumn<PreviewRowResult>>>(
    () => [
      { key: 'row', header: 'Row', align: 'right', cell: (r) => <span className="num">{r.rowNo}</span>, sortValue: (r) => r.rowNo },
      { key: 'outcome', header: 'Outcome', cell: (r) => <StatusPill value={r.valid ? 'valid' : 'invalid'} />, sortValue: (r) => (r.valid ? 'valid' : 'invalid') },
      { key: 'merchant', header: 'Merchant', cell: (r) => r.row.displayName, sortValue: (r) => r.row.displayName },
      { key: 'vpa', header: 'UPI ID', cell: (r) => <span className="font-mono text-xs">{r.row.vpaValue}</span>, sortValue: (r) => r.row.vpaValue },
      { key: 'bank', header: 'Bank / branch', cell: (r) => `${r.row.bankReferenceCode} - ${r.row.branchCode}`, sortValue: (r) => r.row.bankReferenceCode },
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

  return (
    <div className="flex flex-col gap-4">
      <RecentBatches />

      <Card>
        <CardHeader>
          <CardTitle>Bank request file</CardTitle>
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

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          {/* Verified against the real files 2026-08-12: handing the device
              inventory workbook to this drop zone returns SIXTEEN
              missing_required_column errors, every message naming an internal
              canonical field ("Missing required column \"bankMerchantReference\"").
              Two problems that created. Every error shared `code` as its React
              key, so sixteen siblings collided on one key. And the operator's
              actual mistake, picking up the wrong file, was left for them to
              infer from a wall of field names they have never seen. When most
              of the layout is absent, the honest reading is "wrong file", so say
              that first and put the field list behind a disclosure. */}
          {structural.length > 0 && (
            <ErrorNote>
              {structural.every((se) => se.code === 'missing_required_column') && structural.length > 3 ? (
                <>
                  <p className="font-medium">This does not look like a bank request file.</p>
                  <p className="mt-1">
                    {structural.length} of the columns a bank request file must have are missing, so it was not read and
                    nothing was written. Check you picked the right file: device inventory, damage reports and print
                    vendor returns each have their own upload on{' '}
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

          {preview !== null && structural.length === 0 && (
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
                searchPlaceholder="Search merchant, UPI ID or bank code..."
                emptyTitle="No rows"
                // In the grid's own toolbar, top right, so the decision and its
                // evidence share a screen. Below a 340-row table the button sat
                // several screens under the summary it depends on.
                // The badge REPORTS THE OUTCOME. It used to be a hardcoded green
                // "Committed" on `commitResult !== null`, so a commit where every
                // row was held still showed a green tick reading "Committed",
                // three inches above a red box saying nothing was committed. The
                // badge was describing that the request finished, not what it
                // did, and green plus a tick is the strongest "all good" signal
                // on the page.
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
                      {commitResult.quarantined > 0
                        ? `Held for review, 0 committed`
                        : 'Nothing committed'}
                    </span>
                  )
                }
              />
            </>
          )}

          {commitResult !== null && (
            <>
              <PerRowErrors result={commitResult} />
              {/* THIS NOTE IS CONDITIONAL, and that is the whole point. It used
                  to render on `commitResult !== null`, meaning a commit where
                  every row was held still announced "Done. The rows now pool
                  toward a batch" in a calm blue box, directly under a red toast
                  saying nothing was committed. Re-uploading the same file is a
                  NORMAL operator action, so that contradiction was on the most
                  travelled path, not an edge case. A results panel that says
                  "done" has to have something to be done about. */}
              {commitResult.accepted > 0 ? (
                <InfoNote>
                  <strong>
                    {commitResult.accepted} row(s) now pool toward a batch.
                  </strong>{' '}
                  When one triggers (lot size, max wait, or a manual trigger on{' '}
                  <Link className="underline" to="/batches">
                    Batches
                  </Link>
                  ), it mints a Dispatch ID per merchant, and generating the print PDFs happens from that batch.
                </InfoNote>
              ) : (
                <ErrorNote>
                  <strong>Nothing entered the pool.</strong> No row in this file was committed, so no batch will change
                  and there is nothing to generate. The counts above say what happened to each row.{' '}
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
