// Task 8: the batch page's own contextual "what do I do now" card. It reads
// nothing on its own; it is driven entirely by the `journey` prop the page
// already fetched (BatchGeneratePage's getBatchJourney read), and it switches
// on the batch's derived stage (batchStage.ts's `deriveBatchStage`). It CANNOT
// invent a stage vocabulary of its own: PRINTING, SHIPPING, ACTIVATION,
// COMPLETE are the whole set, collapsed to four (rather than the six the
// original brief for this card assumed) because analytics never projects
// REQUEST_SENT_TO_CWD (2026-08-18 controller ruling, spec batch-first-ops-ux
// task 4). Concretely: PRINTING offers the return-sheet dropzone, SHIPPING the
// courier-status dropzone, ACTIVATION both the CWD send actions and the
// activation-file dropzone together, COMPLETE nothing at all.
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
//   activation-file dropzone is offered alongside the button rather than the
//   stage advancing on the strength of a request alone.
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
import { ErrorNote, InfoNote } from '../../../ui/primitives.js'
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js'
import { useToast } from '../../../ui/Toast.js'
import { useAuth } from '../../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../../api/idempotency.js'
import { saveBlob } from '../../../lib/saveBlob.js'
import {
  downloadActivationSheet,
  requestActivation,
  type BatchJourneySummary,
  type BatchJourneyView,
} from '../../../api/endpoints.js'
import { EmbeddedUploadCard } from '../../../components/EmbeddedUploadCard.js'
import { deriveBatchStage } from '../batchStage.js'

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
  // Defensive against an older/partial fixture or a genuinely absent field on
  // the wire: an empty list disables the send button rather than throwing.
  const dispatchIds = (journey.awaitingActivation ?? []).map((row) => row.dispatchId)

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
      const { recorded, unknown } = await requestActivation(client, dispatchIds, newIdempotencyKey())
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

        {stage === 'ACTIVATION' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" disabled={downloading} onClick={() => void handleDownload()}>
                {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                Download activation sheet
              </Button>
              <Button
                type="button"
                disabled={dispatchIds.length === 0}
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

            {downloadError !== null && <ErrorNote>{downloadError}</ErrorNote>}

            <EmbeddedUploadCard kind="activation" batchId={batchId} onDone={onChanged} />
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
          title={`Send the activation request for ${String(dispatchIds.length)} ${dispatchIds.length === 1 ? 'dispatch' : 'dispatches'} to the CWD?`}
          description="Records that the activation request has gone out. It does not activate anything: these dispatches stay awaiting activation until the CWD confirms each device."
          confirmLabel="Mark sent to CWD"
          busy={sending}
          error={sendError}
          onConfirm={() => {
            void handleMarkSent()
          }}
        />
      )}
    </Card>
  )
}
