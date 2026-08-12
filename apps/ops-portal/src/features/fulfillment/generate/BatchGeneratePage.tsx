// Collateral generation, ANCHORED TO THE BATCH. /batches/:btchId/generate.
//
// Generation used to live inside the upload wizard, which was the wrong owner:
// Dispatch IDs are minted when a batch forms, usually days after the file was
// committed, and the print package is a property of the batch, not of an upload
// session. This page is reached from the batch and reads only batch-scoped data,
// so what it previews, what it renders and what the Excel carries all name the
// same Dispatch IDs.
//
// THREE SECTIONS, in the order an operator uses them: proof one card, render the
// run (both paper layouts), take the handover files (run PDFs + the dispatch
// Excel whose Dispatch ID / Device ID / AWB columns the print vendor fills and
// returns).
//
// The card rows are built from the batch's COMPOSED ARTIFACTS: labelQr is the
// exact string the stored PDF was composed with, so the on-screen proof and the
// artifact held against the Dispatch ID cannot drift. No artifacts yet means
// compose has not run (it requires exactly one ACTIVE PRINT vendor), and the page
// says that instead of rendering from data the store never saw.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Download, ExternalLink, FileSpreadsheet, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ErrorNote, InfoNote, EmptyState, Spinner } from '../../../ui/primitives.js'
import { fmtDateTime } from '../../../ui/format.js'
import { useToast } from '../../../ui/Toast.js'
import { saveBlob } from '../../../lib/saveBlob.js'
import { useAuth } from '../../../auth/AuthContext.js'
import {
  downloadDispatchExcel,
  getBatchDetail,
  type BatchDetailView,
  type BatchEntryRow,
} from '../../../api/endpoints.js'
import { CollateralCardProof } from './CollateralCardProof.js'
import { renderCollateralPdf, type CardRow, type RenderedPdf } from './collateralPdf.js'
import { OUTPUT_BUNDLES, bundleById, bundlesFor, copiesLabel, type BundleId } from './collateralBundles.js'
import { SHEET_LAYOUTS, cardsPerPage, type SheetLayout, type SheetLayoutId } from './collateralTemplate.js'

/** The UPI ID, straight out of the QR's own pa= parameter, so there is no second
 *  source for it. The payload shape is upi://pay?k=v&k=v. */
function vpaFromQr(qrValue: string): string {
  const q = qrValue.indexOf('?')
  if (q < 0) return ''
  for (const pair of qrValue.slice(q + 1).split('&')) {
    const [k, v] = pair.split('=')
    if (k === 'pa' && v !== undefined) return decodeURIComponent(v)
  }
  return ''
}

interface GenRow {
  entry: BatchEntryRow
  card: CardRow
}

function BundleSwitch({
  active,
  onChange,
  counts,
}: {
  active: BundleId
  onChange: (b: BundleId) => void
  counts: ReadonlyMap<BundleId, readonly unknown[]>
}) {
  return (
    <div role="tablist" aria-label="Card type" className="inline-flex rounded-lg border bg-muted/40 p-1">
      {OUTPUT_BUNDLES.map((b) => {
        const n = counts.get(b.id)?.length ?? 0
        const on = b.id === active
        return (
          <button
            key={b.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(b.id)}
            className={
              'rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ' +
              (on
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-background hover:text-foreground')
            }
          >
            {b.label}
            <span className={'num ml-1.5 ' + (on ? 'text-primary-foreground/75' : 'text-muted-foreground')}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}

export function BatchGeneratePage() {
  const { btchId } = useParams<{ btchId: string }>()
  const { client } = useAuth()
  const toast = useToast()

  const [detail, setDetail] = useState<BatchDetailView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  // Proof pane state.
  const [bundle, setBundle] = useState<BundleId>('PRINT_CARD')
  const [index, setIndex] = useState(0)
  const [jump, setJump] = useState('')

  // Run render state.
  const [layoutId, setLayoutId] = useState<SheetLayoutId>('trim')
  const [jobs, setJobs] = useState<Partial<Record<BundleId, RenderedPdf & { url: string }>>>({})
  const [renderProgress, setRenderProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const [downloadingExcel, setDownloadingExcel] = useState(false)

  useEffect(() => {
    if (btchId === undefined) return
    let cancelled = false
    getBatchDetail(client, btchId)
      .then((d) => {
        if (cancelled) return
        if (d === null) setNotFound(true)
        else setDetail(d)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load the batch.')
      })
    return () => {
      cancelled = true
    }
  }, [client, btchId])

  /**
   * One CardRow per batch entry, QR taken from the entry's composed artifact.
   * Entries arrive bank+branch sorted from the server, the same order the Excel
   * uses, so "card 3" here and row 3 there are the same merchant.
   */
  const rows = useMemo<readonly GenRow[]>(() => {
    if (detail === null) return []
    const qrByAsgn = new Map<string, string>()
    for (const a of detail.artifacts) {
      if (a.supersededAt === null && !qrByAsgn.has(a.asgnId)) qrByAsgn.set(a.asgnId, a.labelQr)
    }
    return detail.entries
      .map((entry, i): GenRow | null => {
        const qr = qrByAsgn.get(entry.asgnId)
        if (qr === undefined) return null
        return {
          entry,
          card: {
            rowNo: i + 1,
            displayName: entry.merchantDisplayName,
            vpaValue: vpaFromQr(qr),
            qrValue: qr,
            bankReferenceCode: entry.bankReferenceCode,
            branchCode: entry.branchCode ?? '',
          },
        }
      })
      .filter((r): r is GenRow => r !== null)
  }, [detail])

  const bundleRows = useMemo<ReadonlyMap<BundleId, readonly GenRow[]>>(
    () =>
      new Map(
        OUTPUT_BUNDLES.map((b) => [
          b.id,
          rows.filter((r) =>
            bundlesFor({
              soundbox: r.entry.soundbox,
              standeeCount: r.entry.standeeCount,
              stickerCount: r.entry.stickerCount,
            }).includes(b.id),
          ),
        ]),
      ),
    [rows],
  )

  const layout = useMemo<SheetLayout>(() => SHEET_LAYOUTS.find((l) => l.id === layoutId) ?? SHEET_LAYOUTS[0]!, [layoutId])

  const forBundle = bundleRows.get(bundle) ?? []
  const total = forBundle.length
  const current = forBundle[Math.min(index, Math.max(0, total - 1))]

  useEffect(() => {
    setIndex(0)
  }, [bundle])

  const generate = useCallback(async (): Promise<void> => {
    setRenderError(null)
    // Old URLs are revoked before the jobs are replaced so a long session does
    // not leak a blob per render.
    setJobs((prev) => {
      for (const j of Object.values(prev)) if (j !== undefined) URL.revokeObjectURL(j.url)
      return {}
    })
    cancelRef.current = false
    try {
      const out: Partial<Record<BundleId, RenderedPdf & { url: string }>> = {}
      for (const b of OUTPUT_BUNDLES) {
        const bundleCards = (bundleRows.get(b.id) ?? []).map((r) => r.card)
        if (bundleCards.length === 0) continue
        setRenderProgress({ done: 0, total: bundleCards.length, label: b.label })
        const rendered = await renderCollateralPdf(
          // The bundle's leading artifact type supplies geometry and artwork;
          // all types share one template today.
          b.covers[0]!,
          bundleCards,
          layout,
          (done, totalCards) => {
            setRenderProgress({ done, total: totalCards, label: b.label })
          },
          () => cancelRef.current,
        )
        if (cancelRef.current) return
        out[b.id] = { ...rendered, url: URL.createObjectURL(rendered.blob) }
      }
      setJobs(out)
    } catch (err) {
      if (!/cancel/i.test(err instanceof Error ? err.message : '')) {
        setRenderError(err instanceof Error ? err.message : 'Could not render the run.')
      }
    } finally {
      setRenderProgress(null)
    }
  }, [bundleRows, layout])

  async function handleExcel(): Promise<void> {
    if (btchId === undefined) return
    setDownloadingExcel(true)
    try {
      const file = await downloadDispatchExcel(client, btchId)
      saveBlob(file.filename, file.blob)
    } catch (err) {
      toast.show({
        tone: 'error',
        title: 'Excel download failed',
        detail: err instanceof Error ? err.message : 'Could not download the dispatch sheet.',
      })
    } finally {
      setDownloadingExcel(false)
    }
  }

  function onJumpChange(raw: string): void {
    const digits = raw.replace(/\D+/g, '')
    if (digits === '') {
      setJump('')
      return
    }
    setJump(String(Math.min(total, Math.max(1, Number.parseInt(digits, 10)))))
  }

  if (notFound) {
    return <EmptyState title="Batch not found" message="The id in the address does not name a batch." />
  }
  if (loadError !== null) {
    return <ErrorNote>{loadError}</ErrorNote>
  }
  if (detail === null) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner /> Loading the batch
      </div>
    )
  }

  const spec = bundleById(bundle)
  const running = renderProgress !== null
  const totalCards = OUTPUT_BUNDLES.reduce((n, b) => n + (bundleRows.get(b.id)?.length ?? 0), 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* Back to the LIST. It used to point at `/batches/:btchId`, the
              separate detail page, which is now this page: the link pointed at
              itself. */}
          <Link
            to="/batches"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to batches
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Batch collateral</h1>
          <p className="font-mono text-xs text-muted-foreground">{detail.batch.id}</p>
        </div>
        {/* The deleted detail page's Summary tile, folded in. Its three facts
            (records, trigger, print vendor) were the only thing that page
            reported which this one did not, so they move here rather than being
            dropped along with the page. */}
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-muted/30 px-4 py-2.5 text-[12.5px]">
          <div>
            <dt className="text-[11px] text-muted-foreground">Dispatches</dt>
            <dd className="num font-semibold">{detail.entries.length}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Cards</dt>
            <dd className="num font-semibold">{totalCards}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Trigger</dt>
            <dd className="font-semibold">{detail.batch.triggerReason}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted-foreground">Formed</dt>
            <dd className="font-semibold">{fmtDateTime(detail.batch.createdAt)}</dd>
          </div>
        </dl>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <InfoNote>
              <strong>Nothing has been composed for this batch yet.</strong> Compose runs when the batch fact is
              consumed and needs exactly one ACTIVE PRINT vendor (Master Data, Vendor Registry). Once artifacts exist,
              this page previews and packages them.
            </InfoNote>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* SECTION 1: proof one card. */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[15px] font-semibold tracking-tight">Card preview</h2>
                <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  <span className="num">{total}</span> {spec.label.toLowerCase()} card{total === 1 ? '' : 's'}
                </span>
              </div>
              <BundleSwitch active={bundle} onChange={setBundle} counts={bundleRows} />
            </div>
            <CardContent className="pt-5">
              {total === 0 ? (
                <InfoNote>No dispatch in this batch asks for a {spec.label.toLowerCase()} card.</InfoNote>
              ) : (
                <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
                  <div className="space-y-3">
                    <div className="rounded-xl border bg-card p-3 shadow-sm">
                      {current !== undefined && (
                        <CollateralCardProof artifactType={spec.covers[0]!} row={current.card} className="rounded-md" />
                      )}
                    </div>
                    {/* Pager under the card it pages. */}
                    <div className="space-y-2 rounded-xl border bg-muted/20 p-2">
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled={index <= 0}
                          onClick={() => setIndex((i) => Math.max(0, i - 1))}
                        >
                          <ChevronLeft aria-hidden="true" />
                          Previous
                        </Button>
                        <span className="flex-none px-1 font-mono text-[12px] text-muted-foreground">
                          <span className="text-foreground">{Math.min(index + 1, total)}</span> / {total}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled={index >= total - 1}
                          onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                        >
                          Next
                          <ChevronRight aria-hidden="true" />
                        </Button>
                      </div>
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault()
                          const n = Number.parseInt(jump, 10)
                          if (Number.isFinite(n)) setIndex(n - 1)
                          setJump('')
                        }}
                      >
                        <Input
                          value={jump}
                          onChange={(e) => onJumpChange(e.target.value)}
                          inputMode="numeric"
                          aria-label={`Go to card number, 1 to ${total}`}
                          className="h-8 flex-1"
                          placeholder={`Jump to a card, 1 to ${total}`}
                        />
                        <Button type="submit" variant="outline" size="sm" className="flex-none" disabled={jump === ''}>
                          Go
                        </Button>
                      </form>
                    </div>
                  </div>

                  {/* THE RIGHT COLUMN USED TO END AFTER THREE ROWS, leaving most
                      of a tall portrait card's height as blank space, and closed
                      with a sentence explaining the component's own internals
                      ("drawn from the same geometry and QR string as the stored
                      PDF"), which is a note for whoever maintains this file and
                      not something an operator needs on screen.
                      It now carries the run: the selected card's facts, then
                      every other card in the run as a click-to-jump list that
                      grows into the space instead of leaving it empty. */}
                  <div className="flex min-w-0 flex-col gap-3">
                    <div className="space-y-1.5">
                      <h3 className="text-lg font-semibold tracking-tight">{current?.card.displayName ?? ''}</h3>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <span className="rounded-md border bg-muted/40 px-2 py-1 font-mono">{current?.entry.asgnId}</span>
                        <span className="rounded-md border bg-muted/40 px-2 py-1 font-mono">{current?.card.vpaValue}</span>
                        <span className="rounded-md border bg-muted/40 px-2 py-1">
                          bank {current?.card.bankReferenceCode} / {current?.card.branchCode}
                        </span>
                      </div>
                    </div>
                    <dl className="divide-y rounded-xl border">
                      <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
                        <dt className="text-muted-foreground">Run this card as</dt>
                        <dd className="font-medium">
                          {current === undefined
                            ? ''
                            : copiesLabel(bundle, {
                                soundbox: current.entry.soundbox,
                                standeeCount: current.entry.standeeCount,
                                stickerCount: current.entry.stickerCount,
                              })}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
                        <dt className="text-muted-foreground">Legal name</dt>
                        <dd className="min-w-0 truncate font-medium">{current?.entry.merchantLegalName ?? '-'}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 px-3.5 py-2 text-[12.5px]">
                        <dt className="text-muted-foreground">Dispatch state</dt>
                        <dd className="font-medium">{current?.entry.dispatchState ?? 'not dispatched'}</dd>
                      </div>
                      {/* WRAPS, and no longer truncates. This is the exact string
                          that goes into the printed QR, so an operator checking a
                          card against the bank's file needs to read all of it. */}
                      <div className="space-y-1 px-3.5 py-2">
                        <dt className="text-[12.5px] text-muted-foreground">QR payload</dt>
                        <dd className="break-all font-mono text-[11px] leading-relaxed">{current?.card.qrValue}</dd>
                      </div>
                    </dl>

                    {total > 1 && (
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
                        <p className="flex-none border-b bg-muted/30 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                          Cards in this run
                        </p>
                        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
                          {forBundle.map((r, i) => (
                            <li key={r.entry.asgnId}>
                              <button
                                type="button"
                                onClick={() => setIndex(i)}
                                aria-current={i === index ? 'true' : undefined}
                                className={
                                  'flex w-full items-center gap-3 px-3.5 py-2 text-left text-[12.5px] transition-colors ' +
                                  (i === index ? 'bg-primary/10 font-medium' : 'hover:bg-muted/50')
                                }
                              >
                                <span className="num flex-none text-[11px] text-muted-foreground">{i + 1}</span>
                                <span className="min-w-0 flex-1 truncate">{r.card.displayName}</span>
                                <span className="flex-none text-[11px] text-muted-foreground">
                                  {copiesLabel(bundle, {
                                    soundbox: r.entry.soundbox,
                                    standeeCount: r.entry.standeeCount,
                                    stickerCount: r.entry.stickerCount,
                                  })}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* SECTION 2: render the run. */}
          <Card>
            <CardHeader>
              <CardTitle>Print run PDFs</CardTitle>
              <CardDescription>
                One card per merchant per type: {OUTPUT_BUNDLES.map((b) => `${b.label.toLowerCase()} ${bundleRows.get(b.id)?.length ?? 0}`).join(', ')}. Pick the paper, render, then preview in a tab before
                downloading.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {SHEET_LAYOUTS.map((l) => {
                  const on = layoutId === l.id
                  const sheets = Math.ceil(totalCards / cardsPerPage(l))
                  return (
                    <button
                      key={l.id}
                      type="button"
                      disabled={running}
                      onClick={() => {
                        setLayoutId(l.id)
                        setJobs((prev) => {
                          for (const j of Object.values(prev)) if (j !== undefined) URL.revokeObjectURL(j.url)
                          return {}
                        })
                      }}
                      aria-pressed={on}
                      className={
                        'rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ' +
                        (on ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{l.label}</span>
                        {on && <Check className="size-4 flex-none text-primary" aria-hidden="true" />}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{l.description}</p>
                      {totalCards > 0 && (
                        <p className="mt-1.5 text-xs">
                          <span className="num font-medium">{totalCards}</span> cards on about{' '}
                          <span className="num font-medium">{sheets}</span> {sheets === 1 ? 'page' : 'pages'}
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>

              {renderError !== null && <ErrorNote>{renderError}</ErrorNote>}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  disabled={running || totalCards === 0}
                  onClick={() => {
                    void generate()
                  }}
                >
                  {running && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {running
                    ? `Rendering ${renderProgress.label} ${renderProgress.done} of ${renderProgress.total}`
                    : `Render ${totalCards} card(s)`}
                </Button>
                {running && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      cancelRef.current = true
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>

              {running && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-150"
                    style={{ width: `${(renderProgress.done / Math.max(1, renderProgress.total)) * 100}%` }}
                  />
                </div>
              )}

              {OUTPUT_BUNDLES.filter((b) => jobs[b.id] !== undefined).map((b) => {
                const job = jobs[b.id]!
                return (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{b.label} PDF</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="num">{job.cardCount}</span> cards on <span className="num">{job.pageCount}</span>{' '}
                        {job.pageCount === 1 ? 'page' : 'pages'}
                        {job.cardsPerPage > 1 && <> at {job.cardsPerPage} per sheet</>}, {(job.blob.size / 1e6).toFixed(2)} MB
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-2">
                      <Button asChild variant="outline" size="sm">
                        <a href={job.url} target="_blank" rel="noreferrer">
                          <ExternalLink aria-hidden="true" />
                          Preview
                        </a>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          saveBlob(`${detail.batch.id}-${b.id.toLowerCase()}-${layout.id}.pdf`, job.blob)
                        }}
                      >
                        <Download aria-hidden="true" />
                        Download
                      </Button>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          {/* SECTION 3: the handover Excel, previewed before download. */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Dispatch Excel for the print vendor</CardTitle>
                  {/* The sheet split is what the print vendor works from, so it
                      is named here rather than left to be discovered on open.
                      Note the CAVEAT below: until Dispatch IDs are minted per
                      product line, a merchant wanting both appears on both
                      sheets under one id. */}
                  <CardDescription className="mt-1">
                    Two sheets, <span className="font-medium">Soundbox</span> and{' '}
                    <span className="font-medium">Standy</span>, each sorted by bank then branch and carrying the Batch
                    ID. Device ID and AWB ship EMPTY; the vendor fills both sheets in and sends the same workbook back.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  onClick={() => {
                    void handleExcel()
                  }}
                  disabled={downloadingExcel}
                >
                  {downloadingExcel ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet aria-hidden="true" />}
                  Download Excel
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sheet</TableHead>
                      <TableHead>Batch ID</TableHead>
                      <TableHead>Dispatch ID</TableHead>
                      <TableHead>Bank / branch</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead className="text-right">Soundbox</TableHead>
                      <TableHead className="text-right">Standee</TableHead>
                      <TableHead className="text-right">Sticker</TableHead>
                      <TableHead>Device ID</TableHead>
                      <TableHead>AWB</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.entries.slice(0, 10).map((e) => {
                      // The SAME predicates package.ts splits the workbook on, so
                      // the preview cannot claim a sheet the file does not put the
                      // row on. A row can legitimately say "Soundbox + Standy"
                      // today: one Dispatch ID covering both products lands on
                      // both sheets, which is the gap per-product ids will close.
                      const sheets: string[] = []
                      if (e.soundbox) sheets.push('Soundbox')
                      if (e.standeeCount >= 1 || e.stickerCount >= 1) sheets.push('Standy')
                      if (sheets.length === 0) sheets.push('Standy')
                      return (
                        <TableRow key={e.asgnId}>
                          <TableCell className="text-xs">{sheets.join(' + ')}</TableCell>
                          <TableCell className="font-mono text-xs">{detail.batch.id}</TableCell>
                          <TableCell className="font-mono text-xs">{e.asgnId}</TableCell>
                          <TableCell>
                            {e.bankReferenceCode} / {e.branchCode ?? ''}
                          </TableCell>
                          <TableCell>{e.merchantDisplayName}</TableCell>
                          <TableCell className="text-right">{e.soundbox ? 'Y' : 'N'}</TableCell>
                          <TableCell className="num text-right">{e.standeeCount}</TableCell>
                          <TableCell className="num text-right">{e.stickerCount}</TableCell>
                          <TableCell className="text-muted-foreground">(vendor fills)</TableCell>
                          <TableCell className="text-muted-foreground">(vendor fills)</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {detail.entries.length > 10 && (
                <p className="text-xs text-muted-foreground">
                  Showing the first 10 of <span className="num">{detail.entries.length}</span> rows. The downloaded file
                  carries them all, plus address and contact columns this preview deliberately omits.
                </p>
              )}

              {/* THE STORED PER-TYPE PDF DOWNLOADS ARE GONE (2026-08-12, product
                  call). Three buttons here offered the server's own stored
                  artifact per type: soundbox, standee, sticker.
                  Two things were wrong with shipping them.
                  1. WHAT THEY CONTAIN. The stored artifact is a bare QR, with no
                     bank logo, no merchant name, none of the card design. It is
                     an internal record of the QR held against a Dispatch ID, not
                     something a print vendor can print.
                  2. WHERE THEY SAT. They were rendered BELOW the Excel and were
                     live before "Render cards" had ever been pressed, so the
                     first downloadable thing on the page produced the worst
                     possible artifact. An operator reasonably reads the lowest
                     download button as the final output.
                  The print-run PDFs above are the real deliverable and carry the
                  full card design. The server keeps storing per-type artifacts
                  exactly as before; this page just stops offering them as a
                  download. Nothing about compose or the artifact types changed. */}
            </CardContent>
          </Card>
        </>
      )}

      {/* NO RECOMPOSE FORM HERE. I carried one over from the deleted detail page
          on the reasoning that it would otherwise be unreachable; that was the
          wrong call and it was cut on sight (2026-08-12). "Regenerate a QR label
          artifact for an assignment" is an internal repair for a compose that
          went wrong, it has no place in the operator's generate flow, and it
          landed as the largest card on the page under a name that explains
          nothing to the person using it. If a batch needs recomposing, that is a
          support action and needs its own deliberate home, not a leftover. */}
    </div>
  )
}
