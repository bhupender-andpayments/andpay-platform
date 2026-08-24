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
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Boxes, Check, CheckCircle2, Compass, Copy, Download, Eye, ExternalLink, FileSpreadsheet, Loader2, Package, PackageCheck, QrCode, Repeat, Send, Smartphone, Tag, Upload } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CodeChip, ErrorNote, InfoNote, EmptyState, Spinner, StatusPill } from '../../../ui/primitives.js'
import { LifecycleRail, type RailStage } from '../../../ui/LifecycleRail.js'
import { buildRailFromTrail } from '../../../ui/statusRail.js'
import type { StatusTrailEntry } from '../../../api/endpoints.js'
import { BATCH_STATUSES } from '../batchStatuses.js'

// The rail's words and icons for each batch state, keyed off the SAME
// BATCH_STATUSES vocabulary the server owns, so a state added there cannot
// silently vanish from the rail.
const BATCH_RAIL_LABEL: Record<string, string> = {
  BATCHED: 'Batched',
  SENT_TO_PRINT_VENDOR: 'Sent to print vendor',
  CLOSED: 'Closed',
}

const BATCH_RAIL_ICON: Record<string, RailStage['icon']> = {
  BATCHED: Boxes,
  SENT_TO_PRINT_VENDOR: Send,
  CLOSED: CheckCircle2,
}
import { BackLink } from '../../../ui/DetailFacts.js'
import { StatFacts, type StatFactDef } from '../../../ui/StatTiles.js'
import { DataGrid, type GridColumn } from '../../../ui/DataGrid.js'
import { fmtDateTime } from '../../../ui/format.js'
import { useToast } from '../../../ui/Toast.js'
import { saveBlob } from '../../../lib/saveBlob.js'
import { COLLATERAL_GROUP_LABELS, excelGroupsFor } from '../../../lib/dispatchGroups.js'
import { useAuth } from '../../../auth/AuthContext.js'
import {
  closeBatch,
  bulkDeliverBatch,
  downloadDispatchExcel,
  getBatchDetail,
  getBatchTrail,
  sendBatchToVendor,
  type BatchDetailView,
  type BatchEntryRow,
} from '../../../api/endpoints.js'
import { newIdempotencyKey } from '../../../api/idempotency.js'
import { sendToVendorErrorMessage } from '../sendToVendorError.js'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js'
import { DispatchGroupBadge } from '../DispatchGroupBadge.js'
import { QrPreviewDialog } from './QrPreviewDialog.js'
import { renderCollateralPdf, type CardRow, type RenderedPdf } from './collateralPdf.js'
import { OUTPUT_BUNDLES, bundlesFor, type BundleId } from './collateralBundles.js'
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

export function BatchGeneratePage() {
  const { btchId } = useParams<{ btchId: string }>()
  const { client, principal } = useAuth()
  // D-29/DP-8 display gating: the edge denies customer_support the batch
  // binary downloads, so the Excel buttons are not shown to them. Display
  // convenience only, never authorization (S24/T14).
  const downloadsHidden = principal?.roleLabel === 'customer_support'
  const { toast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch ?? ''
  const [copied, setCopied] = useState(false)

  const [detail, setDetail] = useState<BatchDetailView | null>(null)
  // The batch's status trail. This is where the rail's sent-at and closed-at
  // come from: the batch row itself has never carried those columns.
  const [trail, setTrail] = useState<readonly StatusTrailEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  // Which dispatch's card is open. Null is the normal state: the table is the
  // page, and a card is something you ask for about one row.
  const [preview, setPreview] = useState<GenRow | null>(null)

  // Run render state.
  const [layoutId, setLayoutId] = useState<SheetLayoutId>('trim')
  const [jobs, setJobs] = useState<Partial<Record<BundleId, RenderedPdf & { url: string }>>>({})
  const [renderProgress, setRenderProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const cancelRef = useRef(false)
  const [downloadingExcel, setDownloadingExcel] = useState<string | null>(null)
  const [excelError, setExcelError] = useState<string | null>(null)

  // Handing this batch to the print vendor (decision D4).
  const [sendOpen, setSendOpen] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  // Retiring it once every dispatch has settled (decision D5).
  const [closeOpen, setCloseOpen] = useState(false)
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const [deliverOpen, setDeliverOpen] = useState(false)
  const [deliverBusy, setDeliverBusy] = useState(false)
  const [deliverError, setDeliverError] = useState<string | null>(null)
  const [deliverResult, setDeliverResult] = useState<{ delivered: number; skipped: number; failed: number; firstError?: string } | null>(
    null,
  )

  /**
   * Re-read the batch. Separate from the mount effect because compose lands
   * asynchronously: a batch opened the instant it formed has entries but no
   * artifacts, and the operator needs a way to ask again without reloading the
   * whole app and losing any rendered PDFs.
   */
  const reload = useCallback(async (): Promise<void> => {
    if (btchId === undefined) return
    setLoadError(null)
    try {
      const d = await getBatchDetail(client, btchId)
      if (d === null) setNotFound(true)
      else setDetail(d)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the batch.')
    }
  }, [client, btchId])

  useEffect(() => {
    void reload()
  }, [reload])

  // THE TRAIL LOADS ON ITS OWN, deliberately not inside reload(). Chaining it
  // after the detail read made the two share a timeline: the batch page derives
  // its per-dispatch cards from the detail, and a second awaited fetch landing
  // mid-derivation left the QR buttons still disabled when an operator (and a
  // test) clicked one. Independent reads, independent effects.
  //
  // Silent on failure, like every other supporting read here: a trail that does
  // not arrive costs the rail its timestamps, not the page. Keyed on the batch
  // status too, so sending to the vendor or closing refreshes the rung each
  // action just added.
  const reloadTrail = useCallback(async (): Promise<void> => {
    if (btchId === undefined) return
    try {
      const rows = await getBatchTrail(client, btchId)
      setTrail(Array.isArray(rows) ? rows : [])
    } catch {
      setTrail([])
    }
  }, [client, btchId])

  useEffect(() => {
    void reloadTrail()
  }, [reloadTrail])

  const confirmClose = useCallback(async (): Promise<void> => {
    if (btchId === undefined) return
    setCloseBusy(true)
    setCloseError(null)
    try {
      await closeBatch(client, btchId, newIdempotencyKey())
      setCloseOpen(false)
      await reload()
      // The rail gained a rung; refresh it explicitly rather than reactively.
      // A reactive dependency on batch.status was tried and reverted: it fired
      // a second fetch mid-render while this page was still deriving its
      // per-dispatch cards, which left the QR buttons disabled at the moment an
      // operator clicked one.
      await reloadTrail()
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Could not close this batch.')
    } finally {
      setCloseBusy(false)
    }
  }, [client, btchId, reload, reloadTrail])

  const confirmSend = useCallback(async (): Promise<void> => {
    if (btchId === undefined) return
    setSendBusy(true)
    setSendError(null)
    try {
      await sendBatchToVendor(client, btchId, newIdempotencyKey())
      setSendOpen(false)
      // Re-read rather than patching state locally: sending also binds the print
      // vendor, which decides the print layout this page renders with.
      await reload()
      // And the rail's sent-at rung, which only exists now that batches keep a
      // status trail.
      await reloadTrail()
    } catch (err) {
      // The coded 409 reasons get their real sentence; anything else keeps the
      // generic one. See sendToVendorError.ts for why that mattered.
      setSendError(sendToVendorErrorMessage(err, 'Could not send this batch.'))
    } finally {
      setSendBusy(false)
    }
  }, [client, btchId, reload, reloadTrail])

  // 19 Aug 2026 (demo need): bulk-correct every shipment in this batch to
  // DELIVERED in one click. Pure orchestration on the server (bulkDeliverBatch
  // calls the same audited correctStatus once per shipment); this handler is
  // the same shape as confirmSend/confirmClose above, kept open for a beat
  // after success so the summary counts are readable before the dialog closes.
  const confirmDeliverAll = useCallback(async (): Promise<void> => {
    if (btchId === undefined) return
    setDeliverBusy(true)
    setDeliverError(null)
    try {
      const result = await bulkDeliverBatch(client, btchId, newIdempotencyKey())
      setDeliverResult(result)
      // A per-shipment failure is swallowed by the server into the count (it
      // keeps going rather than aborting the rest), so the only place it is
      // visible at all is here: surfaced as a real error, not folded quietly
      // into the neutral description text beside the other two counts.
      if (result.failed > 0) {
        // firstError is the server's one honest sentence about the first
        // failure (23 Aug 2026): without it, "N failed" inside an HTTP 200
        // was undiagnosable from here.
        setDeliverError(
          `${String(result.failed)} of ${String(result.delivered + result.skipped + result.failed)} shipments could not be marked delivered. ${String(result.delivered)} others in this batch went through. Try again, it only retries the ones still not delivered.${
            result.firstError !== undefined ? ` First failure: ${result.firstError}` : ''
          }`,
        )
      }
      await reload()
    } catch (err) {
      setDeliverError(err instanceof Error ? err.message : 'Could not mark this batch delivered.')
    } finally {
      setDeliverBusy(false)
    }
  }, [client, btchId, reload])

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

  /**
   * The card for a dispatch, or nothing when compose has not produced one yet.
   *
   * The table lists EVERY dispatch in the batch, including any whose artifact is
   * missing, because a dispatch that exists with no card is exactly the thing an
   * operator needs to see. Its preview action is then disabled rather than absent:
   * a missing button reads as a rendering fault, a disabled one with a reason
   * reads as the answer.
   */
  const cardByAsgn = useMemo<ReadonlyMap<string, GenRow>>(
    () => new Map(rows.map((r) => [r.entry.asgnId, r])),
    [rows],
  )

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
      // A 340-card run takes long enough that the operator looks away, and the
      // result rows appear below the fold on a small screen. This is the one
      // thing on the page worth a transient confirmation.
      const pages = Object.values(out).reduce((n, j) => n + (j?.pageCount ?? 0), 0)
      if (pages > 0) toast(`Print run ready: ${pages} page(s) across ${Object.keys(out).length} PDF(s)`)
    } catch (err) {
      if (!/cancel/i.test(err instanceof Error ? err.message : '')) {
        setRenderError(err instanceof Error ? err.message : 'Could not render the run.')
      }
    } finally {
      setRenderProgress(null)
    }
  }, [bundleRows, layout, toast])

  // ONE WORKBOOK PER DELIVERY GROUP on this branch, not one combined download.
  // The edge splits the vendor sheet the same way package.ts splits the run
  // (Soundbox, Standy), so the group grammar is the server's, not a client
  // guess, and `excelGroupsFor` reads it off the batch's own artifacts. A 404 is
  // a real answer ("no such group here"), surfaced as null rather than thrown.
  async function handleExcel(group: string): Promise<void> {
    if (btchId === undefined) return
    setDownloadingExcel(group)
    setExcelError(null)
    try {
      const file = await downloadDispatchExcel(btchId, group)
      if (file === null) {
        setExcelError(`This batch has no ${COLLATERAL_GROUP_LABELS[group] ?? group} sheet.`)
        return
      }
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setExcelError(err instanceof Error ? err.message : 'Could not download the dispatch sheet.')
    } finally {
      setDownloadingExcel(null)
    }
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

  const running = renderProgress !== null
  const totalCards = OUTPUT_BUNDLES.reduce((n, b) => n + (bundleRows.get(b.id)?.length ?? 0), 0)

  /**
   * How many of this batch's dispatches the print vendor has actually handed to
   * the courier, or null before the batch has been sent at all.
   *
   * DISPATCHED_BY_VENDOR is written by the return-sheet ingest, one dispatch at a
   * time as sheets arrive, so this is the batch's real progress through the half
   * of its life that its own status word cannot describe.
   */
  const dispatchedCount =
    detail === null || detail.batch.status === 'BATCHED'
      ? null
      : detail.entries.filter((e) => e.dispatchState === 'DISPATCHED_BY_VENDOR').length
  // The readiness condition for "Mark all delivered": every dispatch in the
  // batch must have reached the vendor first, not just some of them.
  // dispatchState only ever reaches DISPATCHED_BY_VENDOR (courier progress
  // past that lives on shpt.status, not here).
  //
  // 23 Aug 2026: this no longer DISABLES the button, at the user's direction.
  // The button always opens its dialog, and the dialog is where the condition
  // is stated with its numbers, the same way Close batch already worked; only
  // the confirm inside is gated. A faded button with a title attribute put
  // the reason somewhere an operator has to hover to find.
  const allDispatchedByVendor = dispatchedCount !== null && detail !== null && dispatchedCount === detail.entries.length
  const settlement = detail.settlement
  // An ABSENT settlement read is not permission to close. It means this server
  // predates the read (the field is optional for exactly that reason), so the
  // honest answer is "cannot tell from here" and the close stays blocked rather
  // than sending a write the server would 409 anyway.
  const canClose = settlement?.settled === true

  // HOW MUCH OF THE RUN THE PRINT VENDOR HAS MAPPED BACK (23 Aug 2026, at the
  // user's direction). "Mapped" is a shipment existing for the leg, which is
  // exactly what a non-null courierStatus proves: readBatchDetail COALESCEs
  // unit.shipment (a soundbox leg whose device the return sheet paired) with
  // pending_pool_entry.collateral_shipment (a collateral leg whose AWB it
  // linked). NOT dispatchState: that only advances for a sheet arriving after
  // the dispatch PM ran, and never for a legacy combined row, so it
  // undercounts what has actually come back.
  const soundboxLegs = detail.entries.filter((e) => e.dispatchGroup === 'SOUNDBOX')
  const collateralLegs = detail.entries.filter((e) => e.dispatchGroup === 'COLLATERAL')
  const mappedOf = (rows: readonly BatchEntryRow[]): number =>
    rows.filter((e) => (e.courierStatus ?? null) !== null).length
  const mappedTotal = mappedOf(detail.entries)
  const mappedSoundbox = mappedOf(soundboxLegs)
  const mappedCollateral = mappedOf(collateralLegs)
  // THE REPLACEMENT SLICE (23 Aug 2026, ops-team ask): how much of this batch
  // exists because something got damaged. Derived from replacementOfAsgnId,
  // which rides every entry natively; no extra read.
  const replacementLegs = detail.entries.filter((e) => (e.replacementOfAsgnId ?? null) !== null)
  const replacementSoundbox = replacementLegs.filter((e) => e.dispatchGroup === 'SOUNDBOX').length
  const replacementCollateral = replacementLegs.filter((e) => e.dispatchGroup === 'COLLATERAL').length
  const replacementStandees = replacementLegs.reduce((n, e) => n + e.standeeCount, 0)
  const replacementStickers = replacementLegs.reduce((n, e) => n + e.stickerCount, 0)

  // ONE SENTENCE OF GUIDANCE, keyed to where the batch is. The buttons say
  // what CAN be done; this says what should happen NEXT, which is the question
  // an operator new to the flow actually has on this page.
  const nextStep = (() => {
    if (detail.batch.status === 'BATCHED') {
      return 'Next: generate the print PDFs and the vendor Excel below, then send this batch to the print vendor.'
    }
    if (detail.batch.status === 'SENT_TO_PRINT_VENDOR') {
      if (canClose) return 'Every dispatch has settled. This batch can be closed.'
      if (mappedTotal < detail.entries.length) {
        return `Next: the print vendor prints and ships the run. Upload their return sheet to map devices and AWBs back to these dispatches. ${String(mappedTotal)} of ${String(detail.entries.length)} mapped so far.`
      }
      return 'Every dispatch is mapped. Waiting for deliveries to settle: Mark all delivered records them at once, and the batch can close when every dispatch is delivered or returned.'
    }
    return 'This batch is closed; every dispatch settled.'
  })()

  const summaryFacts: StatFactDef[] = [
    {
      key: 'status',
      label: 'Status',
      hint: `${detail.batch.triggerReason} trigger, formed ${fmtDateTime(detail.batch.createdAt)}`,
      icon: Package,
      tone: 'text-primary',
      chip: 'bg-primary/10',
      value: (
        <span className="inline-block pt-0.5">
          <StatusPill value={detail.batch.status} />
        </span>
      ),
    },
    {
      key: 'dispatches',
      label: 'Dispatches',
      hint: `${String(soundboxLegs.length)} soundbox, ${String(collateralLegs.length)} collateral legs`,
      icon: Boxes,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: detail.entries.length,
    },
    {
      key: 'cards',
      label: 'QR cards',
      hint: 'ready across the print bundles',
      icon: QrCode,
      tone: 'text-violet-600',
      chip: 'bg-violet-500/10',
      value: totalCards,
    },
    {
      key: 'mapped',
      label: 'Mapped by vendor',
      hint: 'return sheet has come back for these',
      icon: PackageCheck,
      tone: 'text-emerald-600',
      chip: 'bg-emerald-500/10',
      value: `${String(mappedTotal)}/${String(detail.entries.length)}`,
    },
    {
      key: 'mappedSoundbox',
      label: 'Soundbox mapped',
      hint: 'devices paired by the return sheet',
      icon: Smartphone,
      tone: 'text-indigo-600',
      chip: 'bg-indigo-500/10',
      value: `${String(mappedSoundbox)}/${String(soundboxLegs.length)}`,
    },
    {
      key: 'mappedCollateral',
      label: 'Collateral mapped',
      hint: 'AWBs linked by the return sheet',
      icon: Tag,
      tone: 'text-sky-600',
      chip: 'bg-sky-500/10',
      value: `${String(mappedCollateral)}/${String(collateralLegs.length)}`,
    },
  ]
  // Which vendor workbooks this batch actually has, from its ENTRIES rather than
  // its artifacts: the Excel is a picking sheet for what was ordered, and a
  // collateral-only dispatch has a sheet without ever composing a card. Sharing
  // the predicate with the edge (lib/dispatchGroups.ts) is what stops a button
  // offering a download the server answers 404 to.
  const excelGroups = excelGroupsFor(detail.entries)

  // The batch's three states as a rail, built from the batch's own trail
  // (STATUS_STAGES.md, 21 Aug 2026).
  //
  // ALL THREE RUNGS NOW CARRY THEIR REAL INSTANT. Until the trail existed only
  // the first could: the batch row records createdAt and nothing else, so a
  // sent-at or closed-at would have had to be invented, and this rail correctly
  // refused to invent one. batch_status_event records every transition, so the
  // two timestamps an operator actually asks for ("when did this go to the
  // vendor", "when was it closed") are answerable at last.
  //
  // Batch has no terminal branches: the three states are one line, and CLOSED
  // is the end of it rather than a branch off it.
  const batchRail: RailStage[] = buildRailFromTrail({
    spine: BATCH_STATUSES,
    terminals: [],
    trail,
    label: (k) => BATCH_RAIL_LABEL[k] ?? k,
    icon: (k) => BATCH_RAIL_ICON[k] ?? Boxes,
  })

  // WHAT IS IN THIS BATCH, one row per Dispatch ID, in the order the server sorted
  // them (bank then branch), which is the same order the vendor Excel uses.
  const dispatchColumns: GridColumn<BatchEntryRow>[] = [
    {
      key: 'asgnId',
      header: 'Dispatch ID',
      cell: (e) => (
        <span className="flex items-center gap-2">
          <CodeChip>{e.asgnId}</CodeChip>
          <DispatchGroupBadge group={e.dispatchGroup} />
        </span>
      ),
      sortValue: (e) => e.asgnId,
    },
    {
      key: 'merchant',
      header: 'Merchant',
      cell: (e) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-foreground">{e.merchantDisplayName}</span>
          {/* DAMAGE.md: a replacement in the batch says so. The batch page had
              no way to know until replacementOf started riding the assignment
              fact, and the operator's question here is a real one: a batch of
              replacements is a batch the bank is already chasing. */}
          {(e.replacementOfAsgnId ?? null) !== null && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Replacement
            </span>
          )}
        </span>
      ),
      sortValue: (e) => e.merchantDisplayName,
    },
    {
      key: 'bank',
      // TWO COLUMNS, not one "3 / 30" string (18 Aug 2026, at the user's
      // correction): a combined cell cannot be sorted or scanned by either
      // half, which is the same reasoning the three ordered quantities above
      // already carry.
      header: 'Bank',
      cell: (e) => e.bankReferenceCode,
      sortValue: (e) => e.bankReferenceCode,
    },
    {
      key: 'branchCode',
      header: 'Branch',
      cell: (e) => e.branchCode ?? <span className="text-muted-foreground">-</span>,
      sortValue: (e) => e.branchCode ?? '',
    },
    // The three ordered quantities, each its own column: this is the sheet the
    // print vendor picks against, and "Soundbox, 3 standee" as one string cannot
    // be sorted or scanned down a column.
    { key: 'soundbox', header: 'Soundbox', cell: (e) => (e.soundbox ? 'Y' : 'N'), sortValue: (e) => (e.soundbox ? 1 : 0), align: 'right' },
    { key: 'standee', header: 'Standee', cell: (e) => e.standeeCount, sortValue: (e) => e.standeeCount, align: 'right' },
    { key: 'sticker', header: 'Sticker', cell: (e) => e.stickerCount, sortValue: (e) => e.stickerCount, align: 'right' },
    {
      key: 'dispatchState',
      header: 'State',
      // A StatusPill, like every other status cell on the portal (18 Aug 2026,
      // at the user's correction): this column was the one rendering a raw
      // uppercase token as plain text.
      //
      // courierStatus WINS once it exists (19 Aug 2026): dispatchState never
      // reaches DELIVERED by design, it stops at DISPATCHED_BY_VENDOR, so a
      // shipment corrected past that (a courier update, or "Mark all
      // delivered") showed no change at all in this column. courierStatus is
      // null until a shipment exists for the leg, so dispatchState is still
      // the right word for everything before the vendor has shipped it.
      cell: (e) => {
        const shown = e.courierStatus ?? e.dispatchState
        return shown === null ? (
          <span className="text-muted-foreground">not dispatched</span>
        ) : (
          <StatusPill value={shown} />
        )
      },
      sortValue: (e) => e.courierStatus ?? e.dispatchState ?? '',
    },
    // A separate "Settled" column was tried here and cut on sight (18 Aug 2026,
    // at the user's correction): State above already answers "what is this
    // dispatch's status" more usefully, and a second column saying "Still in
    // flight" for every row that has not yet reached a courier terminal state
    // added a label without adding information. The close dialog's own
    // breakdown (perDispatch on `settlement`) is what still answers "why can't
    // I close this batch"; it does not need a column of its own on this table.
    {
      key: 'qr',
      header: '',
      cell: (e) => {
        const row = cardByAsgn.get(e.asgnId)
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={row === undefined}
            title={row === undefined ? 'No card has been composed for this dispatch yet.' : undefined}
            aria-label={`View QR card for ${e.merchantDisplayName}`}
            onClick={(ev) => {
              // The row navigates to the dispatch; opening the card preview
              // must not also do that.
              ev.stopPropagation()
              if (row !== undefined) setPreview(row)
            }}
          >
            <Eye aria-hidden="true" />
            QR
          </Button>
        )
      },
    },
  ]

  async function copyBatchId(id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast(`Copied ${id}`)
    } catch {
      /* clipboard denied: the id stays selectable */
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The shared BackLink, carrying the list's filters home, and the same
          hero grammar as the device page: icon chip, the id the operator is
          here about, a copy button. */}
      <BackLink to="/batches" label="Batches" fromSearch={fromSearch} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Boxes className="size-5 text-primary" aria-hidden="true" />
          </span>
          <div>
            <h1 className="num flex items-center gap-2 text-xl font-semibold tracking-tight">
              {detail.batch.id}
              <button
                type="button"
                aria-label="Copy batch id"
                onClick={() => void copyBatchId(detail.batch.id)}
                className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
              >
                {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
              </button>
            </h1>
            <p className="text-sm text-muted-foreground">Batch collateral: cards, print PDFs and the vendor Excel.</p>
          </div>
          {/* The lifecycle action lives beside the id it acts on, offered only
              while the batch is BATCHED because that is the only state it is
              legal in. The server refuses anything else with a 409 regardless;
              hiding it spares the operator learning that by being told no. */}
          {detail.batch.status === 'BATCHED' && (
            <Button
              aria-label={`Send batch ${detail.batch.id} to the print vendor`}
              onClick={() => {
                setSendError(null)
                setSendOpen(true)
              }}
            >
              <Send className="size-4" aria-hidden="true" /> Send to print vendor
            </Button>
          )}
          {/* MOVED HERE from the Batches list header (18 Aug 2026, the user's
              explicit correction). Offered anywhere else, the upload has no
              batch in hand to check a file against; here it always does, and
              the page it opens (ReturnUploadPage) refuses whole any file
              naming a dispatch that is not one of THIS batch's own entries. */}
          {detail.batch.status === 'SENT_TO_PRINT_VENDOR' && (
            <Button
              variant="secondary"
              onClick={() => navigate(`/uploads/return?batch=${encodeURIComponent(detail.batch.id)}`)}
            >
              <Upload className="size-4" aria-hidden="true" /> Upload return sheet
            </Button>
          )}
          {/* Closing is offered from the moment the batch is with the vendor and
              is ALWAYS CLICKABLE (18 Aug 2026, at the user's correction). It
              used to be rendered disabled with the count beside it, and a faded
              button reads as "not implemented yet" rather than "not yet": the
              reason was on screen but easy to miss, and there was nowhere to
              find out WHICH dispatches were holding the batch open. Clicking now
              always opens the dialog, and the dialog either confirms the close
              or explains what it is waiting on. The confirm action inside is
              what stays disabled, and the server re-checks regardless. */}
          {detail.batch.status === 'SENT_TO_PRINT_VENDOR' && (
            <Button
              variant="secondary"
              aria-label={`Close batch ${detail.batch.id}`}
              onClick={() => {
                setCloseError(null)
                setCloseOpen(true)
              }}
            >
              <CheckCircle2 className="size-4" aria-hidden="true" /> Close batch
            </Button>
          )}
          {/* 19 Aug 2026, demo shortcut: bulk-correct every shipment in this
              batch straight to DELIVERED, one click instead of one dispatch at
              a time.

              GATED on every dispatch having reached the vendor (19 Aug 2026,
              at the user's direction): disabled, not hidden, while any
              dispatch is still short of DISPATCHED_BY_VENDOR, with the same
              N-of-M count the pill above already shows, so the reason is on
              screen rather than a silently missing button. */}
          {detail.batch.status === 'SENT_TO_PRINT_VENDOR' && (
            <Button
              variant="secondary"
              aria-label={`Mark every dispatch in batch ${detail.batch.id} delivered`}
              onClick={() => {
                setDeliverError(null)
                setDeliverResult(null)
                setDeliverOpen(true)
              }}
            >
              <PackageCheck className="size-4" aria-hidden="true" /> Mark all delivered
            </Button>
          )}
        </div>
      </div>

      {/* WHAT TO DO NEXT, in words (23 Aug 2026, at the user's direction). The
          action buttons above say what is possible; this says what the flow
          expects now, so an operator who has never run a batch is not left to
          infer the order from which buttons happen to be enabled. Given its
          own treatment rather than a plain InfoNote (the user's own
          direction, 23 Aug 2026): a compass chip and a tinted, bordered card
          so the one sentence that answers "what now" reads as the page's
          focal point rather than another neutral aside. */}
      <div className="flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3 dark:bg-primary/10">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Compass className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 pt-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary/80">Next step</p>
          <p className="mt-0.5 text-[13.5px] text-foreground">{nextStep}</p>
        </div>
      </div>

      {/* THE RUN AT A GLANCE (23 Aug 2026), replacing the cramped facts strip
          that used to sit beside the header. Status/Trigger/Formed keep their
          home in the first card; the three Mapped cards answer the question
          the strip never could: how much of the run has the print vendor
          actually returned to us. Presentational on purpose (StatFacts, not
          StatTiles): one batch's numbers filter nothing. The old
          "Shipped by vendor" pill is folded into these rather than kept
          alongside them, because it counted a slightly different axis
          (dispatchState) and two near-identical counts on one screen is the
          one-value-two-names trap the Dispatches page already fixed. */}
      <StatFacts facts={summaryFacts} />

      {/* THE REPLACEMENT STRIP, rendered ONLY when the batch carries any
          (23 Aug 2026, ops-team ask). AMBER, the same tone as the REPLACEMENT
          pill on the rows below and the slice in the pool's Batch preview, so
          the three surfaces read as one fact. A batch with no replacements
          shows nothing here: an always-on zero would demote the highlight to
          furniture. */}
      {replacementLegs.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-2xl border border-amber-300 bg-amber-500/[0.08] px-4 py-3 dark:border-amber-800 dark:bg-amber-500/10">
          <span className="flex items-center gap-1.5">
            <Repeat className="size-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              Replacements in this batch
            </span>
          </span>
          <span className="num text-[13px] font-semibold text-foreground">
            {replacementLegs.length === 1 ? '1 dispatch' : `${String(replacementLegs.length)} dispatches`}
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            {[
              replacementSoundbox > 0 ? `${String(replacementSoundbox)} soundbox` : null,
              replacementCollateral > 0
                ? `${String(replacementCollateral)} collateral (${String(replacementStandees)} standee${
                    replacementStandees === 1 ? '' : 's'
                  }, ${String(replacementStickers)} sticker${replacementStickers === 1 ? '' : 's'})`
                : null,
            ]
              .filter((part) => part !== null)
              .join(', ')}
          </span>
        </div>
      )}

      {/* THE BATCH'S OWN LIFECYCLE (18 Aug 2026, at the user's correction). The
          same shared rail the dispatch, shipment and device pages use, so all
          four read identically: a batch has three states and the summary chip
          above named only the current one, leaving where it sits in the whole
          progression to be worked out. */}
      <Card>
        <CardContent>
          <div className="pb-5">
            <CardTitle>Batch lifecycle</CardTitle>
            <CardDescription>
              Formed, sent to the print vendor, then closed once every dispatch has settled.
            </CardDescription>
          </div>
          <LifecycleRail stages={batchRail} />
        </CardContent>
      </Card>

      {/* SECTION 1: WHAT IS IN THE BATCH. The page opens on the dispatch list
          because that is the question an operator arrives with ("is this
          merchant in this batch, and what did they ask for"), and a card is
          something they then want to see for one of them.
          It replaces a pager that walked the run one card at a time: previous,
          next, and a jump-to-number box over a list nobody could search. */}
      <Card>
        <CardHeader>
          <CardTitle>Dispatches in this batch</CardTitle>
          <CardDescription>
            One row per Dispatch ID, sorted by bank then branch, the same order the vendor Excel uses. QR opens that
            merchant's card as it will print.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataGrid
            columns={dispatchColumns}
            rows={detail.entries}
            getRowKey={(e) => e.asgnId}
            // Clicking a row opens that dispatch (18 Aug 2026, at the user's
            // correction). The QR button in the trailing cell stops its own
            // propagation, so the two do not fight.
            onRowClick={(e) => navigate(`/dispatches/${e.asgnId}`)}
            searchPlaceholder="Search merchant, bank or dispatch…"
            emptyTitle="This batch has no dispatches"
            emptyMessage="Nothing was claimed into it, which should not happen once a trigger has run."
            pageSize={20}
            pageSizeOptions={[20, 50, 100]}
            stickyFirstColumn
          />
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
            {/* NOTHING TO RENDER YET is a state of this section alone, not of the
                page: the dispatch list above and the vendor Excel below are both
                fine without a single composed card. It used to blank the whole
                screen, which made a batch look broken seconds after forming.
                Compose runs off the batch fact, so this clears itself; the
                Refresh is here because a page that tells you to wait should also
                let you check. */}
            {totalCards === 0 ? (
              <InfoNote>
                <strong>No cards have been composed for this batch yet.</strong> Composing needs exactly one active
                print vendor in Master Data, Vendor Registry, and usually lands a few moments after the batch forms.
                The dispatch list above and the vendor Excel below work meanwhile.
                <span className="mt-2 block">
                  <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
                    Check again
                  </Button>
                </span>
              </InfoNote>
            ) : (
              <>
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
              </>
            )}
          </CardContent>
        </Card>

        {/* SECTION 3: the handover Excel. */}
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
                  One workbook per delivery group, each sorted by bank then branch and carrying the Batch ID. Device ID
                  and AWB ship EMPTY; the vendor fills them in and sends the same workbook back, which you then upload
                  on{' '}
                  <Link className="underline" to="/uploads/return">
                    Print vendor return
                  </Link>
                  .
                </CardDescription>
              </div>
              {/* One button per group the batch ACTUALLY has, read off its own
                  artifacts, rather than two fixed buttons where one 404s. */}
              <div className="flex flex-wrap gap-2">
                {!downloadsHidden && excelGroups.map((g) => (
                  <Button
                    key={g}
                    type="button"
                    onClick={() => {
                      void handleExcel(g)
                    }}
                    disabled={downloadingExcel !== null}
                  >
                    {downloadingExcel === g ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <FileSpreadsheet aria-hidden="true" />
                    )}
                    {COLLATERAL_GROUP_LABELS[g] ?? g}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {excelError !== null && <ErrorNote>{excelError}</ErrorNote>}
            {/* NO ROW PREVIEW HERE ANY MORE. This carried the first 10 entries
                in a table of its own: Sheet, Batch ID, Dispatch ID, bank,
                merchant, the three counts, and two "(vendor fills)" columns.
                Every one of those columns is now in the dispatch table at the
                top of this page, for every row rather than ten, with search and
                sorting. Two tables of the same data on one screen, one of them
                truncated, is a way to disagree with yourself. The sheet split is
                described in words above instead, which is the part the table was
                really there to explain. */}
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

      {/* One dialog, driven by whichever row asked for it, rather than one per
          row: mounting a dialog per dispatch would mount its SVG card and its QR
          encode for every row in the batch. */}
      {preview !== null && (
        <QrPreviewDialog
          open
          onOpenChange={(next) => {
            if (!next) setPreview(null)
          }}
          entry={preview.entry}
          card={preview.card}
        />
      )}

      {/* CLOSE, and WHY NOT (redesigned 23 Aug 2026 at the user's direction).
          The old body was a five-cell grid where "Delivered / Returned /
          Damaged" and "Still in flight" sat side by side as peers, which is
          exactly backwards: the first three ARE settled and the fourth is
          what blocks the close. They are now two panels split by a rule, the
          settled side summing to one number and the blocking side standing
          alone, and the explainer is one short line with the three settling
          words emphasised rather than a paragraph. */}
      <ConfirmDialog
        open={closeOpen}
        wide
        title={canClose ? 'Close this batch' : 'This batch cannot be closed yet'}
        description={
          settlement === undefined
            ? `Close ${detail.batch.id}.`
            : canClose
              ? 'Every dispatch has settled. Closing retires the batch; its dispatches and devices are unaffected.'
              : `${String(settlement.pending)} of ${String(settlement.total)} dispatches are still travelling.`
        }
        confirmLabel="Close batch"
        confirmDisabled={!canClose}
        busy={closeBusy}
        error={closeError}
        onConfirm={() => void confirmClose()}
        onOpenChange={(open) => {
          if (!open) {
            setCloseOpen(false)
            setCloseError(null)
          }
        }}
      >
        {settlement !== undefined && (
          <div className="space-y-3">
            <div className="grid gap-4 rounded-xl border bg-muted/20 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center">
              {/* SETTLED: the three ways a dispatch stops travelling, and
                  their sum. Delivered and Returned are not interchangeable (a
                  returned dispatch settles without the merchant receiving
                  anything), and DAMAGED is a dispatch verdict from
                  settlement.perDispatch, so each number both locates and
                  explains its rows in the table below. */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Settled</p>
                <div className="mt-2 flex items-end gap-5">
                  {(
                    [
                      ['Delivered', settlement.delivered, 'text-emerald-600'],
                      ['Returned', settlement.returned, 'text-amber-600'],
                      ['Damaged', settlement.damaged ?? 0, 'text-red-600'],
                    ] as ReadonlyArray<[string, number, string]>
                  ).map(([label, value, tone]) => (
                    <div key={label}>
                      <p className={`num text-[22px] font-bold leading-none ${value > 0 ? tone : 'text-muted-foreground/50'}`}>
                        {value}
                      </p>
                      <p className="mt-1 text-[11.5px] text-muted-foreground">{label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* The rule that makes the two sides read as different kinds of
                  thing rather than five peers. */}
              <div className="hidden h-14 w-px bg-border sm:block" aria-hidden="true" />

              <div className="sm:pl-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Still in flight
                </p>
                <p
                  className={`num mt-2 text-[32px] font-bold leading-none ${
                    settlement.pending > 0 ? 'text-primary' : 'text-emerald-600'
                  }`}
                >
                  {settlement.pending}
                </p>
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  of {settlement.total} dispatches
                </p>
              </div>
            </div>

            {!canClose && (
              <p className="text-[12.5px] text-muted-foreground">
                A dispatch settles when it is{' '}
                <span className="font-semibold text-emerald-600">Delivered</span>,{' '}
                <span className="font-semibold text-amber-600">Returned</span>, or its device is flagged{' '}
                <span className="font-semibold text-red-600">Damaged</span>. The unsettled ones are the rows in the
                dispatch table that have done none of the three.
              </p>
            )}
          </div>
        )}
      </ConfirmDialog>

      {/* MARK ALL DELIVERED, and WHY NOT YET (redesigned 23 Aug 2026 at the
          user's direction, same treatment Close batch already had). The button
          used to be rendered disabled with its reason in a title attribute, so
          the operator had to hover a faded control to learn anything. It is
          always clickable now: the dialog states the condition with its own
          numbers and only the confirm is gated, and the server re-checks
          regardless. */}
      <ConfirmDialog
        open={deliverOpen}
        wide
        title={
          deliverResult !== null
            ? 'Marked delivered'
            : allDispatchedByVendor
              ? 'Mark every dispatch in this batch delivered'
              : 'Not every dispatch has reached the vendor yet'
        }
        description={
          deliverResult !== null
            ? undefined
            : allDispatchedByVendor
              // SAYS WHAT IT ACTUALLY DOES (23 Aug 2026): the write targets
              // SHIPMENTS, never dispatches or devices directly. Each parcel
              // moving carries its own devices in the same transaction and
              // announces its dispatches on one fact, which is why the sentence
              // names the parcel as the thing being marked.
              ? `Every parcel in ${detail.batch.id} still short of delivered is marked delivered. Their dispatches and devices follow.`
              : `${String((dispatchedCount ?? 0))} of ${String(detail.entries.length)} dispatches have been shipped by the print vendor.`
        }
        confirmLabel={deliverResult !== null ? 'Done' : 'Mark all delivered'}
        confirmDisabled={deliverResult === null && !allDispatchedByVendor}
        busy={deliverBusy}
        error={deliverError}
        onConfirm={() => {
          if (deliverResult !== null) {
            setDeliverOpen(false)
            return
          }
          void confirmDeliverAll()
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeliverOpen(false)
            setDeliverError(null)
            setDeliverResult(null)
          }
        }}
      >
        {deliverResult !== null ? (
          // THE OUTCOME, as three numbers rather than one run-on sentence.
          <div className="grid grid-cols-3 gap-4 rounded-xl border bg-muted/20 p-4">
            {(
              [
                ['Delivered', deliverResult.delivered, 'text-emerald-600'],
                ['Skipped', deliverResult.skipped, 'text-muted-foreground'],
                ['Failed', deliverResult.failed, 'text-red-600'],
              ] as ReadonlyArray<[string, number, string]>
            ).map(([label, value, tone]) => (
              <div key={label}>
                <p className={`num text-[22px] font-bold leading-none ${value > 0 ? tone : 'text-muted-foreground/50'}`}>
                  {value}
                </p>
                <p className="mt-1 text-[11.5px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {/* THE CONDITION, stated as a checklist row with its own count, so
                "why is the confirm greyed out" is answered in the dialog
                rather than in a tooltip. */}
            <div className="flex items-center gap-4 rounded-xl border bg-muted/20 p-4">
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                  allDispatchedByVendor ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'
                }`}
              >
                {allDispatchedByVendor ? (
                  <CheckCircle2 className="size-5" aria-hidden="true" />
                ) : (
                  <Loader2 className="size-5" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">Every dispatch shipped by the print vendor</p>
                <p className="text-[11.5px] text-muted-foreground">
                  {allDispatchedByVendor
                    ? 'Met. Each dispatch has a shipment to correct.'
                    : 'Required before the whole batch can be marked delivered in one go.'}
                </p>
              </div>
              <p
                className={`num shrink-0 text-[20px] font-bold leading-none ${
                  allDispatchedByVendor ? 'text-emerald-600' : 'text-amber-600'
                }`}
              >
                {dispatchedCount ?? 0}/{detail.entries.length}
              </p>
            </div>

            <p className="text-[12.5px] text-muted-foreground">
              {allDispatchedByVendor ? (
                <>
                  A dispatch with <span className="font-semibold text-foreground">no device paired</span> yet has no
                  shipment and is skipped, not failed.
                </>
              ) : (
                <>
                  Upload the print vendor's{' '}
                  <span className="font-semibold text-foreground">return sheet</span> for the remaining dispatches
                  first: it is what creates their shipments, and there is nothing to mark delivered until it has.
                </>
              )}
            </p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={sendOpen}
        title="Send this batch to the print vendor"
        description={`${String(detail.entries.length)} dispatches in ${detail.batch.id} move to sent to print vendor, the batch is bound to the active print vendor, and the vendor can pull the run. The return sheet can only be uploaded after this.`}
        confirmLabel="Send to print vendor"
        busy={sendBusy}
        error={sendError}
        onConfirm={() => void confirmSend()}
        onOpenChange={(open) => {
          if (!open) {
            setSendOpen(false)
            setSendError(null)
          }
        }}
      />

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
