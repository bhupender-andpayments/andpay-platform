import { useState } from 'react'
import { useAuth } from '../../../auth/AuthContext.js'
import { newIdempotencyKey } from '../../../api/idempotency.js'
import { DataTable, type DataTableColumn } from '../../../components/DataTable.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { markActivated, type BatchDetailView, type BatchJourneyView } from '../../../api/endpoints.js'
import { CodeChip, ErrorNote, InfoNote } from '../../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'

// Stage 8, the last step of the lifecycle. ONE RECORD PER CLICK.
//
// NO MARK-ALL BUTTON, deliberately. `markActivated` marks exactly one dispatch and
// no bulk write exists anywhere in the system, so a "Mark all" here could only be a
// client-side loop. A loop that fails halfway leaves the operator unable to tell
// which records went through: the screen would have claimed an action it only
// partly took. Rejected on that ground, not on effort.
//
// A fresh Idempotency-Key per click, never one reused across rows: the key is what
// makes a retried click safe, and one key covering two records would make the
// second a silent no-op.
//
// SIM ACTIVATION IS NOT A ZERO. `activation.simActivated` is always null on the
// wire because sim_activation_status has no write path anywhere in the system, so
// this stage reports it as not available. Same treatment TilesPage gives its two
// activation-empty tiles, for the same reason: a zero would read as "none
// activated", which is a measurement nobody has made.
type AwaitingRow = BatchJourneyView['awaitingActivation'][number]

export function ActivationStage({
  derived,
  batchDetail: _batchDetail,
  btchId: _btchId,
  onChanged,
}: {
  derived: DerivedWorkflow
  batchDetail: BatchDetailView | null
  btchId: string
  onChanged: () => void
}) {
  const { client } = useAuth()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activation = derived.facts.activation
  // Out of the derivation, like everything else a stage claims. Always an array, so
  // there is nothing to guard here.
  const rows: readonly AwaitingRow[] = derived.facts.awaitingActivation

  async function handleActivate(dispatchId: string): Promise<void> {
    setError(null)
    setBusyId(dispatchId)
    try {
      await markActivated(client, dispatchId, newIdempotencyKey())
      // The worklist has changed, so the page re-reads rather than this component
      // guessing at the new shape of it.
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark the record activated.')
    } finally {
      setBusyId(null)
    }
  }

  const columns: DataTableColumn<AwaitingRow>[] = [
    { key: 'merchant', header: 'Merchant', cell: (r) => r.merchantDisplay },
    { key: 'awb', header: 'AWB', cell: (r) => (r.awb === null ? '-' : <CodeChip>{r.awb}</CodeChip>) },
    { key: 'delivered', header: 'Delivered', cell: (r) => fmtDateTime(r.deliveryDate) },
    {
      key: 'action',
      header: 'Action',
      cell: (r) => (
        <Button
          size="sm"
          disabled={busyId !== null}
          onClick={() => {
            void handleActivate(r.dispatchId)
          }}
        >
          Mark activated
        </Button>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activation</CardTitle>
        <CardDescription>
          Only a delivered record can be activated, and the edge enforces that server-side. Paper does not activate, so
          a collateral-only record never appears here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {activation === null ? (
          <InfoNote>
            The batch journey read has not answered for this batch, so the activation counts are not available yet.
          </InfoNote>
        ) : /* NOT APPLICABLE IS NOT ZERO, and the two zeros this replaces were
              indistinguishable on screen. A batch holding only COLLATERAL has
              nothing that can ever be activated, and rendering "Awaiting 0,
              Activated 0" invited the reading that none of them had been done
              yet. Nobody is ever going to do them: paper does not activate
              (W-5), and the edge 409s the write. Same rule the SIM marker below
              follows, applied to the counts themselves. */
        derived.facts.deliverableSubsetEmpty ? (
          <InfoNote>
            Nothing in this batch can be activated. Every record in it is collateral, a sticker or a standee, and paper
            does not activate: there is no device to bring online, and the edge refuses the write rather than the screen
            hiding the button. This stage has no work for this batch and never will.
          </InfoNote>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Awaiting activation</div>
              <div className="num mt-1 text-[26px] font-semibold leading-none text-foreground">
                {fmtNumber(activation.awaiting)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Activated</div>
              <div className="num mt-1 text-[26px] font-semibold leading-none text-foreground">
                {fmtNumber(activation.activated)}
              </div>
            </div>
            {/* Prose, not a numeral, at the same optical position as the counts
                beside it. The marker must not borrow the measurement treatment,
                because it is not a measurement. */}
            {!derived.facts.simActivationAvailable ? (
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">SIM activation</div>
                <p className="mt-1 text-[15px] leading-tight text-muted-foreground">Not available yet</p>
              </div>
            ) : null}
          </div>
        )}

        {error !== null ? <ErrorNote>{error}</ErrorNote> : null}

        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.dispatchId}
          emptyMessage="No delivered record is waiting to be activated."
        />
      </CardContent>
    </Card>
  )
}
