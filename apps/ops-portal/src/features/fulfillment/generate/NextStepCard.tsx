// Task 8: the batch page's own contextual "what do I do now" card. It reads
// nothing on its own; it is driven entirely by the `journey` prop the page
// already fetched (BatchGeneratePage's getBatchJourney read), and it switches
// on the batch's derived stage (batchStage.ts's `deriveBatchStage`). It CANNOT
// invent a stage vocabulary of its own: PRINTING, SHIPPING, ACTIVATION,
// COMPLETE are the whole set, collapsed to four (rather than the six the
// original brief for this card assumed) because analytics never projects
// REQUEST_SENT_TO_CWD (2026-08-18 controller ruling, spec batch-first-ops-ux
// task 4). Concretely: PRINTING offers the return-sheet dropzone, SHIPPING the
// courier-status dropzone, ACTIVATION the activation-file dropzone.
//
// THE CWD BLOCK KEYS ON DEVICE-PAIRED ROWS, NOT ON THE STAGE (2026-08-19
// rework). `awaitingActivation[].deviceCount > 0` means that row was already
// device-paired at return-sheet ingest (it reached DISPATCHED_BY_VENDOR), so
// the per-batch activation sheet is already valid for it and CWD can already
// act on it, independent of what the rest of the batch is doing. The block
// renders whenever `cwdRows.length > 0 && stage !== 'COMPLETE'`, `cwdRows`
// being `awaitingActivation` filtered to `deviceCount > 0`. Concretely this
// means a batch still at PRINTING (say 9 of 10 dispatched by the vendor) can
// already show the block right alongside the return-sheet dropzone for the
// one row that came back paired, and a partially delivered SHIPPING batch can
// render BOTH the courier-status dropzone AND the CWD block at once, one
// under the other with its own heading: the operator should not have to wait
// for the last shipment, or the last vendor dispatch, to act on the rows that
// are already ready. COMPLETE is excluded because everything activatable is
// already activated by then.
//
// WHY THE CWD ACTIONS LIVE HERE (adapted from features/activation/
// ActivationPage.tsx's "THE BATCHES CARD" header block, D-16/T4.1b, ahead of
// Task 12 slimming that page's own copy of this card away): the CWD is sent
// ONE SHEET PER BATCH, and an operator working a single batch had no way to
// see, or act on, the batch grain the send actually happens at from a
// dispatch-grain worklist alone. Two things this card deliberately does not
// do, carried over unchanged from that reasoning:
//
//   It does not FETCH a separate batch rollup of its own. It is driven by the
//   very `journey` prop the rest of this page already has, so a dispatch count
//   named here can never claim something the rest of the page does not also
//   show.
//
//   It does not ACTIVATE anything. "Mark sent to CWD" posts to
//   /ops/assignments/request-activation, which records REQUEST_SENT_TO_CWD,
//   an activation REQUEST fact, not an activation. Those dispatches are still
//   awaiting the CWD's own confirmation afterwards, which is why the
//   activation-file dropzone is offered alongside the button (at ACTIVATION)
//   rather than the stage advancing on the strength of a request alone.
//
// NO REMARK BOX on the confirmation, for the same reason ActivationPage's
// version never had one: /ops/assignments/request-activation accepts no
// remark on the wire, and a field the server silently drops would be a lie.
//
// `hidden` is DISPLAY GATING ONLY (D-29/DP-8, customer_support), never
// authorization; the edge is the sole authority either way (S24/T14).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, Loader2, Send } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { CodeChip, ErrorNote, InfoNote } from '../../../ui/primitives.js'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js'
import { useToast } from '../../../ui/Toast.js'
import { useAuth } from '../../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../../api/idempotency.js'
import { saveBlob } from '../../../lib/saveBlob.js'
import {
  downloadActivationSheet,
  markActivated,
  markActivatedBulk,
  requestActivation,
  type BatchJourneySummary,
  type BatchJourneyView,
} from '../../../api/endpoints.js'
import { EmbeddedUploadCard } from '../../../components/EmbeddedUploadCard.js'
import { deriveBatchStage } from '../batchStage.js'

type CwdRow = BatchJourneyView['awaitingActivation'][number]

// Operator-facing wording for a per-row outcome, the same split
// ActivationPage's own bulk flow uses: the server sends a code, and the
// wording lives here so an operator never has to read the wire vocabulary.
function outcomeLabel(code: string): string {
  switch (code) {
    case 'activated':
      return 'Activated'
    case 'already-activated':
      return 'Already activated'
    case 'not-activatable':
      return 'Collateral does not activate'
    case 'unknown-dispatch':
      return 'Not found'
    default:
      return code
  }
}

export function NextStepCard({
  batchId,
  journey,
  batchAsgnIds,
  hidden,
  onChanged,
}: {
  batchId: string
  journey: BatchJourneyView
  batchAsgnIds: ReadonlySet<string>
  hidden: boolean
  onChanged: () => void
}): JSX.Element | null {
  const { client } = useAuth()
  const { toast } = useToast()
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // The batch-scoped activation list's own state, mirroring ActivationPage's
  // worklist in miniature (D-19/T5.4's per-row-outcome shape), but scoped to
  // this one batch's device-paired rows rather than the cross-batch report.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [rowOutcome, setRowOutcome] = useState<ReadonlyMap<string, string>>(new Map())
  const [confirmingBulk, setConfirmingBulk] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [confirmingRow, setConfirmingRow] = useState<CwdRow | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  // D-29/DP-8 display gating: customer_support gets no action-bearing content
  // here at all. Cosmetic only, never authorization (S24/T14): the edge still
  // decides every write this card could otherwise offer.
  if (hidden) return null

  // The controller ruling's mapping: `activation.notRequested`/`.requested`
  // are always null on the wire (analytics never projects
  // REQUEST_SENT_TO_CWD), and `.activated` mirrors the counts this page
  // already renders, never a second source for the same number.
  const summary: BatchJourneySummary = {
    batchId: journey.batchId,
    counts: journey.counts,
    activation: { notRequested: null, requested: null, activated: journey.counts.activated },
  }
  const { stage } = deriveBatchStage(summary)
  // The rows CWD can actually act on: device-paired at return-sheet ingest
  // (deviceCount > 0). `?? 0` is defensive against an older/partial fixture
  // or a genuinely absent field on the wire, not a real code path on the
  // live projection (BatchJourneyView's own field is never optional there).
  const cwdRows = (journey.awaitingActivation ?? []).filter((row) => (row.deviceCount ?? 0) > 0)
  const cwdDispatchIds = cwdRows.map((row) => row.dispatchId)
  // The section keys on device-paired rows, not on the stage (2026-08-19
  // rework): it renders whenever something is actually ready for CWD,
  // regardless of whether the rest of the batch is still at PRINTING or
  // SHIPPING. COMPLETE is the one stage excluded, because everything
  // activatable is already activated by then.
  const showCwd = cwdRows.length > 0 && stage !== 'COMPLETE'

  async function handleDownload(): Promise<void> {
    setDownloading(true)
    setDownloadError(null)
    try {
      const file = await downloadActivationSheet(batchId)
      if (file === null) {
        setDownloadError('This batch has nothing awaiting activation, so there is no sheet to download.')
        return
      }
      saveBlob(file.filename, file.blob)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Could not download the activation sheet.')
    } finally {
      setDownloading(false)
    }
  }

  async function handleMarkSent(): Promise<void> {
    setSending(true)
    setSendError(null)
    try {
      const { recorded, unknown } = await requestActivation(client, cwdDispatchIds, newIdempotencyKey())
      toast(
        unknown.length === 0
          ? `Activation request sent to the CWD: ${String(recorded.length)} recorded.`
          : `Activation request sent to the CWD: ${String(recorded.length)} recorded, ${String(unknown.length)} not found.`,
      )
      setConfirming(false)
      onChanged()
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to record the activation request for this batch.')
    } finally {
      setSending(false)
    }
  }

  function toggleRow(dispatchId: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(dispatchId)) next.delete(dispatchId)
      else next.add(dispatchId)
      return next
    })
  }

  async function handleMarkSelectedActivated(): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return
    setBulkError(null)
    setBulkBusy(true)
    try {
      const { results } = await markActivatedBulk(client, ids, newIdempotencyKey())
      const outcome = new Map<string, string>()
      for (const r of results) outcome.set(r.dispatchId, r.activated ? 'activated' : (r.reason ?? 'not activated'))
      setRowOutcome((prev) => new Map([...prev, ...outcome]))
      setSelected(new Set())
      setConfirmingBulk(false)
      onChanged()
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to mark the selected dispatches activated.')
    } finally {
      setBulkBusy(false)
    }
  }

  async function handleMarkOneActivated(row: CwdRow): Promise<void> {
    setRowError(null)
    setRowBusyId(row.dispatchId)
    try {
      await markActivated(client, row.dispatchId, newIdempotencyKey())
      setRowOutcome((prev) => new Map(prev).set(row.dispatchId, 'activated'))
      setConfirmingRow(null)
      onChanged()
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Failed to mark activated.')
    } finally {
      setRowBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Next step</CardTitle>
        <CardDescription>
          {stage === 'PRINTING' &&
            'Pair the print vendor’s return sheet once devices come back, to move this batch toward shipping.'}
          {stage === 'SHIPPING' && 'Upload the courier status file once these shipments are on the way.'}
          {stage === 'ACTIVATION' &&
            'Send the activation sheet to the CWD, then record its activation file when that comes back.'}
          {stage === 'COMPLETE' && 'This batch has finished the workflow.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stage === 'PRINTING' && (
          <EmbeddedUploadCard kind="return" batchId={batchId} batchAsgnIds={batchAsgnIds} onDone={onChanged} />
        )}

        {stage === 'SHIPPING' && <EmbeddedUploadCard kind="courier-status" batchId={batchId} onDone={onChanged} />}

        {showCwd && (
          <div className="space-y-4">
            <p className="text-sm font-semibold text-foreground">Ready for CWD activation</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" disabled={downloading} onClick={() => void handleDownload()}>
                {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                Download activation sheet
              </Button>
              <Button
                type="button"
                disabled={cwdDispatchIds.length === 0}
                onClick={() => {
                  setSendError(null)
                  setConfirming(true)
                }}
              >
                <Send aria-hidden="true" />
                Mark sent to CWD
              </Button>
              <Link className="text-sm underline underline-offset-2" to="/activation">
                Cross-batch activation worklist
              </Link>
            </div>

            <p className="text-sm text-muted-foreground">
              The sheet covers the {cwdRows.length} dispatched {cwdRows.length === 1 ? 'device' : 'devices'} awaiting
              activation.
            </p>

            {downloadError !== null && <ErrorNote>{downloadError}</ErrorNote>}

            {/* The batch-scoped activation list: one row per device-paired
                dispatch still awaiting activation, so an operator working
                this one batch can act at the same grain the CWD confirms at
                (the device), not just the grain the sheet is sent at (the
                batch). Compact by design (D-19/T5.4's per-row-outcome shape,
                shrunk to fit under the buttons above): the raw table
                primitives, never the paginated DataGrid, and no
                search/filter row of its own, since this list is already
                scoped to one batch's handful of rows rather than the
                cross-batch worklist. */}
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all"
                        checked={cwdRows.length > 0 && selected.size === cwdRows.length}
                        onCheckedChange={(checked) => {
                          setSelected(checked === true ? new Set(cwdDispatchIds) : new Set())
                        }}
                      />
                    </TableHead>
                    <TableHead>Merchant</TableHead>
                    <TableHead>Dispatch ID</TableHead>
                    <TableHead>AWB</TableHead>
                    <TableHead>Devices</TableHead>
                    <TableHead>Last result</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cwdRows.map((row) => {
                    const outcome = rowOutcome.get(row.dispatchId)
                    return (
                      <TableRow key={row.dispatchId}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Select ${row.merchantDisplay}`}
                            checked={selected.has(row.dispatchId)}
                            onCheckedChange={() => toggleRow(row.dispatchId)}
                          />
                        </TableCell>
                        <TableCell className="font-medium text-foreground">{row.merchantDisplay}</TableCell>
                        <TableCell>
                          <CodeChip>{row.dispatchId}</CodeChip>
                        </TableCell>
                        <TableCell>{row.awb ?? '-'}</TableCell>
                        <TableCell>{row.deviceCount}</TableCell>
                        <TableCell>
                          {outcome === undefined ? (
                            <span className="text-muted-foreground">-</span>
                          ) : (
                            outcomeLabel(outcome)
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={rowBusyId === row.dispatchId}
                            onClick={() => {
                              setRowError(null)
                              setConfirmingRow(row)
                            }}
                          >
                            {rowBusyId === row.dispatchId && <Loader2 className="animate-spin" aria-hidden="true" />}
                            Mark activated
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={selected.size === 0 || bulkBusy}
                onClick={() => {
                  setBulkError(null)
                  setConfirmingBulk(true)
                }}
              >
                {selected.size === 0 ? 'Mark selected activated' : `Mark ${String(selected.size)} activated`}
              </Button>
            </div>

            {stage === 'ACTIVATION' && <EmbeddedUploadCard kind="activation" batchId={batchId} onDone={onChanged} />}
          </div>
        )}

        {stage === 'COMPLETE' && <InfoNote>Nothing left to do here. This batch has been delivered and activated.</InfoNote>}
      </CardContent>

      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfirming(false)
              setSendError(null)
            }
          }}
          title={`Send the activation request for ${String(cwdDispatchIds.length)} ${cwdDispatchIds.length === 1 ? 'dispatch' : 'dispatches'} to the CWD?`}
          description="Records that the activation request has gone out. It does not activate anything: these dispatches stay awaiting activation until the CWD confirms each device."
          confirmLabel="Mark sent to CWD"
          busy={sending}
          error={sendError}
          onConfirm={() => {
            void handleMarkSent()
          }}
        />
      )}

      {confirmingRow !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setConfirmingRow(null)
              setRowError(null)
            }
          }}
          title={`Mark ${confirmingRow.merchantDisplay} activated?`}
          description="Records that the CWD confirmed this device and its SIM. This cannot be undone from here."
          confirmLabel="Mark activated"
          busy={rowBusyId === confirmingRow.dispatchId}
          error={rowError}
          onConfirm={() => {
            if (confirmingRow !== null) void handleMarkOneActivated(confirmingRow)
          }}
        />
      )}

      <ConfirmDialog
        open={confirmingBulk}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmingBulk(false)
            setBulkError(null)
          }
        }}
        title={`Mark ${String(selected.size)} ${selected.size === 1 ? 'record' : 'records'} activated?`}
        description="Records that the CWD confirmed each device and SIM. This cannot be undone from here; each record reports its own result in the list."
        confirmLabel={selected.size === 0 ? 'Mark selected activated' : `Mark ${String(selected.size)} activated`}
        busy={bulkBusy}
        error={bulkError}
        onConfirm={() => {
          void handleMarkSelectedActivated()
        }}
      />
    </Card>
  )
}
