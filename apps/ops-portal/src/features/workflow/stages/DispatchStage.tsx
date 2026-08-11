import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoNote } from '../../../ui/primitives.js'
import { fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'
import type { BatchDetailView } from '../../../api/endpoints.js'

// Stage 6. Two numbers and one warning, because two numbers and one warning is
// everything the system knows here.
//
// The warning is load-bearing. One request can travel under TWO AWBs, the soundbox
// kit under one and the standee under another, so an operator comparing an AWB
// count against a record count will find more AWBs than records and conclude
// something is duplicated. It is not. Saying so here costs a line; not saying it
// costs a support ticket.
//
// With no journey read there are no numbers, and this stage renders that rather
// than zeros: a zero would say "nothing has been returned", when the truth is that
// nothing has been asked.
export function DispatchStage({
  derived,
  batchDetail: _batchDetail,
  btchId: _btchId,
  onChanged: _onChanged,
}: {
  derived: DerivedWorkflow
  batchDetail: BatchDetailView | null
  btchId: string
  onChanged: () => void
}) {
  const counts = derived.facts.counts

  return (
    <Card>
      <CardHeader>
        <CardTitle>Returned and dispatched</CardTitle>
        <CardDescription>
          Courier tracking begins on its own once a shipment exists. Nothing here has to be started.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {counts === null ? (
          <InfoNote>
            The batch journey read has not answered for this batch, so these counts are not available yet.
          </InfoNote>
        ) : (
          <div>
            <div className="text-xs text-muted-foreground">Returned by the print vendor</div>
            <div className="num mt-1 text-[26px] font-semibold leading-none text-foreground">
              {`${fmtNumber(counts.dispatched)} of ${fmtNumber(counts.total)}`}
            </div>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          A single request can travel under two AWBs, the soundbox kit under one and the standee under another, so the
          shipment count for this batch can exceed the record count without anything being wrong.
        </p>
      </CardContent>
    </Card>
  )
}
