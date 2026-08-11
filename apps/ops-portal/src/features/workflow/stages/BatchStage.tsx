import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeChip, StatusPill } from '../../../ui/primitives.js'
import { fmtDateTime, fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'
import type { BatchDetailView } from '../../../api/endpoints.js'

// Stage 3, the hinge between the two modes.
//
// POOL MODE EXPLAINS AND POINTS. It used to render BatchablePools itself, which
// put the only trigger in the workspace behind a stage pool mode reaches only
// after an in-session commit: pooled work that was waiting for a human was
// visible on the landing view and unreachable from it. BatchablePools now renders
// in LiveWorkView, which is on screen on every load, so the trigger is always
// reachable.
//
// It is NOT rendered in both. LiveWorkView and this stage are on screen together
// whenever pool mode reaches step 3, so a copy here would put two reason fields
// and two "Trigger batch" buttons on one page for the same pool, with two ids.
// One control, one source of truth; this stage says what batching is and where
// the control is.
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
  derived: _derived,
  batchDetail,
  btchId: _btchId,
  onChanged: _onChanged,
}: {
  derived: DerivedWorkflow
  batchDetail: BatchDetailView | null
  btchId: string
  onChanged: () => void
}) {
  if (batchDetail === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Waiting on the pool</CardTitle>
          <CardDescription>
            Batching is per tenant and program, never per bank, so one batch can span many bank codes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Stated before the operator goes looking for a button: batching is not
              something that has to be started. */}
          <p className="text-sm text-muted-foreground">
            A batch forms on its own once the pool reaches its lot size, or once its max wait elapses. Nothing has to be
            started here.
          </p>
          {/* Where the control is, because it is on this same page and above this
              stage rather than in it. A manual trigger is an override of the
              pool's own economics, which is why the reason there is mandatory. */}
          <p className="text-sm text-muted-foreground">
            To form one now, use the pool card above: the reason typed there is recorded on the batch.
          </p>
        </CardContent>
      </Card>
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
