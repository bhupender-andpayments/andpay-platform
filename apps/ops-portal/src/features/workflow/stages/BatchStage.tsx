import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BatchablePools } from '../../fulfillment/BatchablePools.js'
import { CodeChip, StatusPill } from '../../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'
import type { BatchDetailView } from '../../../api/endpoints.js'

// Stage 3, the hinge between the two modes.
//
// POOL MODE renders the EXISTING BatchablePools unchanged. That component already
// owns the per-pool reason field, the (tenant, program) grouping, the stock
// advisory and the trigger call itself, and reimplementing any of it here would
// give the workspace a second trigger that has to be kept in step with the first.
// `onChanged` is wired to its `onTriggered` so the page around this stage re-reads
// once a batch forms; without that the workspace would show a pool it had just
// emptied.
//
// BATCH MODE is a summary of one formed batch. It states only what the batch read
// carries, and in particular it does NOT restate `unitCount` as devices: that
// number is the count of pooled MERCHANT RECORDS claimed when the batch formed,
// and no physical device is attached to a batch until the print vendor's return
// sheet binds one.
//
// Which mode is which comes from `batchDetail`: pool mode has no batch to detail.
// The workspace passes null there in pool mode, and a non-null detail is the only
// thing that can make this stage's batch summary true.
export function BatchStage({
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
  void derived
  void btchId

  if (batchDetail === null) {
    return (
      <div className="space-y-4">
        {/* Stated before the operator goes looking for a button: batching is not
            something that has to be started. A manual trigger is an override of
            the pool's own economics, which is why BatchablePools makes the reason
            mandatory. */}
        <p className="text-sm text-muted-foreground">
          A batch forms on its own once the pool reaches its lot size, or once its max wait elapses. Triggering one
          below forms it early, so the reason is recorded on the batch.
        </p>
        <BatchablePools onTriggered={onChanged} />
      </div>
    )
  }

  const batch = batchDetail.batch
  return (
    <Card>
      <CardHeader>
        <CardTitle>Batch formed</CardTitle>
        <CardDescription>Batching is per tenant and program, never per bank, so one batch can span many bank codes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Batch</div>
            <div className="mt-1">
              <CodeChip>{batch.id}</CodeChip>
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Records</div>
            <div className="num mt-1 text-lg">{fmtNumber(batch.unitCount)}</div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Trigger</div>
            <div className="mt-1">
              <StatusPill value={batch.triggerReason} />
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Formed</div>
            <div className="mt-1 text-sm text-foreground">{fmtDateTime(batch.createdAt)}</div>
          </div>
        </div>

        {/* BRD 5.3.4: the reason an operator gave for forcing this batch. Rendered
            only when there is one, which in practice means only for MANUAL. A
            "Reason: none" line on every automatic batch would be noise pretending
            to be a record. */}
        {batch.triggerNote !== null && batch.triggerNote !== '' ? (
          <div className="border-t border-border pt-3">
            <div className="text-xs text-muted-foreground">Reason given</div>
            <div className="text-sm text-foreground">{batch.triggerNote}</div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
