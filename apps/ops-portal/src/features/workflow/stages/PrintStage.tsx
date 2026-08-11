import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { downloadCollateral, downloadDispatchExcel, type BatchDetailView } from '../../../api/endpoints.js'
import { saveBlob } from '../../../lib/saveBlob.js'
import { COLLATERAL_GROUP_LABELS, collateralGroupsFor, excelGroupsFor } from '../../../lib/dispatchGroups.js'
import { ErrorNote, InfoNote, StatusPill } from '../../../ui/primitives.js'
import { fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'

// Stage 5. THE STAGE WITH NOTHING TO PRESS, and that is also the whole design.
//
// TWO CLAIMS ARE DELIBERATELY ABSENT.
//
// 1. NO MARK-AS-SENT BUTTON. `dispatch_state` advances to SENT_TO_VENDOR at the
//    end of the composition transaction itself (services/fulfillment/src/
//    dispatch.ts), so by the time an operator can see this stage the transition
//    has already happened. A button would either do nothing or need a write that
//    does not exist anywhere in the system.
//
// 2. NO "PACKAGE DOWNLOADED" CLAIM. The print vendor pulls the package under
//    their own credential through a stateless streaming route
//    (apps/vendor-edge/src/pull.controller.ts). Nothing records that they did:
//    the only trace is a 6e record in the `auth` context, which ops-edge is
//    forbidden to read (C4). So this stage says the package is AVAILABLE, which
//    is true, and never that it was taken, which we cannot know.
//
// The downloads here are the operator's own copy for checking the file. They are
// NOT the handoff, and the copy says so, because an operator who thinks pressing
// one of these hands the batch over will wait for a vendor who was never told.
//
// The group predicates come from lib/dispatchGroups.ts, the same module the batch
// detail page's Downloads card uses. Extracted rather than copied (ruled
// 2026-08-11): the Excel rule must stay equivalent to package.ts excelLinesFor,
// and one copy is easier to keep equivalent than two.
export function PrintStage({
  derived,
  batchDetail,
  btchId,
  onChanged,
}: {
  derived: DerivedWorkflow
  batchDetail: BatchDetailView | null
  btchId: string
  onChanged: () => void
}) {
  void onChanged

  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadNote, setDownloadNote] = useState<string | null>(null)

  // Both handlers carry the THREE-WAY outcome the batch detail page established:
  // a thrown error is a failure, a `null` return is the edge's deliberate 404 for
  // a group this batch has no file for and is an informational note rather than an
  // error, and anything else is a save.
  async function handleDispatchExcel(groupKey: string): Promise<void> {
    setDownloadError(null)
    setDownloadNote(null)
    setDownloading(true)
    try {
      const file = await downloadDispatchExcel(btchId, groupKey)
      if (file === null) {
        setDownloadNote(`No ${COLLATERAL_GROUP_LABELS[groupKey] ?? groupKey} Excel exists for this batch.`)
      } else {
        saveBlob(file.filename, file.blob)
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the dispatch sheet.')
    } finally {
      setDownloading(false)
    }
  }

  async function handleCollateral(groupKey: string): Promise<void> {
    setDownloadError(null)
    setDownloadNote(null)
    setDownloading(true)
    try {
      const file = await downloadCollateral(btchId, groupKey)
      if (file === null) {
        setDownloadNote(`No ${COLLATERAL_GROUP_LABELS[groupKey] ?? groupKey} collateral exists for this batch.`)
      } else {
        saveBlob(file.filename, file.blob)
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download the collateral.')
    } finally {
      setDownloading(false)
    }
  }

  const entries = batchDetail?.entries ?? []
  const excelGroups = excelGroupsFor(entries)
  const collateralGroups = collateralGroupsFor(batchDetail?.artifacts ?? [])
  const layout = batchDetail?.printLayout === 'GRID_3X2' ? '3x2 grid' : 'one per page'
  // What the batch read itself says about the handoff: the records composition has
  // already moved to SENT_TO_VENDOR. A count of rows, not a claim about the vendor.
  const sentToVendor = entries.filter((e) => e.dispatchState === 'SENT_TO_VENDOR').length
  const returned = derived.facts.counts?.dispatched ?? null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Available to the print vendor</CardTitle>
          <CardDescription>
            The package became available the moment composition finished. There is nothing to send.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* NO AVAILABILITY TIMESTAMP HERE YET, and the blank is deliberate.
              dispatch_row.sent_to_vendor_at does exist and the
              print-vendor-pendency report already exposes it, but BatchJourneyView
              does not select it, so this stage has no honest instant to show.
              Substituting the batch's own createdAt (when the batch FORMED, which
              is earlier and different) or updatedAt (which moves for unrelated
              reasons) would put a plausible wrong time on screen, which is exactly
              the class of defect this workspace exists to remove. Widening the
              analytics read and its DTO is tracked outside features/workflow. */}
          <p className="text-sm text-foreground">
            The print vendor can pull it now, under their own credential. Nothing records when they do, so this stage
            cannot tell you whether they have.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <StatusPill value="SENT_TO_VENDOR" />
            <span>
              {fmtNumber(sentToVendor)} of {fmtNumber(entries.length)} records in the package
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Layout: {layout}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Check the file</CardTitle>
          <CardDescription>
            These downloads are your own copy, for checking what the vendor will get. They are not the handoff, and
            pressing one sends nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-3">
            {excelGroups.map((g) => (
              <Button key={`${g}-excel`} onClick={() => void handleDispatchExcel(g)} disabled={downloading}>
                {COLLATERAL_GROUP_LABELS[g] ?? g} Excel
              </Button>
            ))}
            {collateralGroups.map((g) => (
              <Button key={g} variant="outline" onClick={() => void handleCollateral(g)} disabled={downloading}>
                {COLLATERAL_GROUP_LABELS[g] ?? g} PDF
              </Button>
            ))}
          </div>
          {collateralGroups.length === 0 ? (
            <InfoNote>No collateral has been composed for this batch yet.</InfoNote>
          ) : null}
          {downloadError !== null ? <ErrorNote>{downloadError}</ErrorNote> : null}
          {downloadNote !== null ? <InfoNote>{downloadNote}</InfoNote> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Waiting on the vendor</CardTitle>
          <CardDescription>
            A return row pairs a device to a request and births the shipment that carries the AWB. That row is the first
            observable sign the vendor has acted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Honesty rule 3: the journey read is what knows how many have come
              back, so with no journey there is no number, and a zero here would
              read as "the vendor has returned nothing" when the truth is that we
              have not asked. */}
          {returned === null ? (
            <InfoNote>Awaiting device ids and AWBs. Nothing has been returned that this screen can see yet.</InfoNote>
          ) : (
            <p className="text-sm text-muted-foreground">
              Awaiting device ids and AWBs. {fmtNumber(returned)} of{' '}
              {fmtNumber(derived.facts.counts?.total ?? 0)} records have been returned so far.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
