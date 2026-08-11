import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { WatermarkBadge } from '../../../components/WatermarkBadge.js'
import { InfoNote, StatusPill } from '../../../ui/primitives.js'
import { fmtNumber } from '../../../ui/format.js'
import type { DerivedWorkflow } from '../workflowStage.js'
import type { BatchDetailView } from '../../../api/endpoints.js'

// Stage 7. A SPREAD, NOT A STATUS.
//
// The records in one batch are at different courier stages at the same moment, so
// there is no single courier status for a batch and any attempt to show one has to
// pick a winner. This stage shows the fan-out instead: five tiles, one per courier
// bucket, which is exactly what readBatchJourney counts.
//
// The numbers are ANALYTICS numbers, served from a projection that lags the write
// side, so the freshness watermark is rendered beside them rather than letting them
// read as live truth. That is the same D100 badge the dashboard tiles and every
// mediated report already carry.

// The four buckets that have a real backend status string, so each label goes
// through StatusPill and picks up the same colour the same status has on every
// other screen in the portal.
const COURIER_TILES: readonly { status: string; pick: (c: NonNullable<DerivedWorkflow['facts']['courier']>) => number }[] = [
  { status: 'PICKED_UP', pick: (c) => c.pickedUp },
  { status: 'IN_TRANSIT', pick: (c) => c.inTransit },
  { status: 'OUT_FOR_DELIVERY', pick: (c) => c.outForDelivery },
  { status: 'DELIVERED', pick: (c) => c.delivered },
]

// The exception bucket is RTO **or** FAILED, so it has no single status string to
// pill and takes the tone directly instead. Character for character the
// TONE_ACCENT.negative border from features/dashboards/TilesPage.tsx: that map is
// private to the page module, so it is restated here rather than imported, and no
// new colour is introduced.
const NEGATIVE_BORDER = 'border-l-[3px] border-l-red-400'
const NEUTRAL_BORDER = 'border-l-[3px] border-l-border'

function Tile({ label, value, border }: { label: ReactNode; value: number; border: string }) {
  return (
    <div className={`min-w-0 rounded-lg border border-border bg-card p-4 ${border}`}>
      <div className="num text-[22px] font-semibold leading-none text-foreground">{fmtNumber(value)}</div>
      <div className="mt-2">{label}</div>
    </div>
  )
}

export function DeliveryStage({
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
  void batchDetail
  void btchId
  void onChanged

  const courier = derived.facts.courier

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where the parcels are</CardTitle>
        <CardDescription>
          Delivery is tracked on the device parcel, so a delivered standee never marks a merchant delivered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {courier === null ? (
          <InfoNote>
            The batch journey read has not answered for this batch, so the courier spread is not available yet.
          </InfoNote>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {COURIER_TILES.map((t) => (
                <Tile
                  key={t.status}
                  label={<StatusPill value={t.status} />}
                  value={t.pick(courier)}
                  border={NEUTRAL_BORDER}
                />
              ))}
              {/* Terminal but not delivered: an RTO or a failed attempt. Its own
                  tile because a record sitting here needs a human, and folding it
                  into a neutral count would hide that. */}
              <Tile
                label={<span className="text-[13px] font-medium text-muted-foreground">Exception</span>}
                value={courier.exception}
                border={NEGATIVE_BORDER}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Served from the analytics projection, which lags the write side.</span>
              <WatermarkBadge watermark={derived.facts.watermark?.asOf ?? null} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
