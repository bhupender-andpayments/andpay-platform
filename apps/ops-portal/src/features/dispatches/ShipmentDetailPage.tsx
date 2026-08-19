import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { AlertTriangle, Bike, Boxes, Calendar, PackageCheck, PackageOpen, Radio, Route, Truck, Undo2 } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getDispatchDetail,
  getDispatches,
  getReport,
  getVendors,
  reportRowShptId,
  type DispatchDetailView,
  type DispatchRow,
  type ReportRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { Button, Card, CardBody, ErrorNote, EmptyState, SkeletonRows, StatusPill, CodeChip } from '../../ui/primitives.js'
import { CorrectStatusDialog, OverrideStatusDialog } from './ShipmentActionDialogs.js'
import { LifecycleTimeline, type TimelineStage, type TimelineTerminal } from '../../ui/LifecycleTimeline.js'
import { LifecycleRail, type RailStage } from '../../ui/LifecycleRail.js'
import { BackLink, FactRow, NoValue, SectionHeading } from '../../ui/DetailFacts.js'
import { fmtDateTime, statusMeta } from '../../ui/format.js'
import { SHIPMENT_RUNG, isOffLadder } from './dispatchStatus.js'

// ONE PARCEL, by its AWB. The carrier axis has the best history in the platform:
// the courier trail is genuinely append-only, keeps the courier's reported instant
// AND the moment we recorded it, names the channel that told us, and holds an
// operator's reason when a status was forced. So unlike a dispatch's early rungs,
// every row here is a real event and is rendered as one, repeats included.
//
// HOW THIS PAGE IS ASSEMBLED, stated plainly because it is not ideal. There is no
// ops read that takes a shipment id, so this page finds its shipment in the
// shipment LIST, finds the dispatch that carries it in the delivery report, and
// takes the trail from that dispatch's detail read, which is the very same
// shpt_status_event rows keyed by this very shipment. Three reads to render one
// parcel is the honest cost of the routes that exist today; a
// GET /ops/shipments/:id (+ its trail) would collapse it to one and is the right
// backend ask.
//
// THE SHIPMENT WRITES LIVE HERE, on the parcel they change, and THIS IS THE
// ONLY PLACE A STATUS IS EVER WRITTEN BY HAND. One status landing on a
// shipment - from the courier's file or from these dialogs - moves all three
// views at once: the shipment row, every device on it (courier-status.ts
// cascades DELIVERED/RETURNED to the units), and the dispatch's courier
// status, which is projected off the shipment. That is why the dispatch page
// has NO status pen and must never get one: its courier status is a DERIVED
// value, and a pen on the derived copy would create two sources of truth for
// one fact. (The inventory device edit is different: a device's status column
// IS the source of truth for that device.)
//
// ONE BUTTON BY DEFAULT. "Record courier update" is the routine tool (the
// file missed an update; record it through the same forward-only ladder).
// "Override" bypasses that ladder, so it is step-up-gated and reason-bearing,
// and it only APPEARS when the parcel sits at a terminal status - the one
// situation the routine tool cannot act on and the emergency tool exists for.
// Day to day, the ops team sees one button.
//
// A DISPATCH CAN TRAVEL UNDER TWO AWBs (the soundbox kit under one, the standee
// under another) and only the device parcel is joined to the analytics row today,
// so a collateral-only parcel can be shown from the shipment list but has no
// dispatch to walk back to. The page says so rather than implying the link is
// broken.

export function ShipmentDetailPage() {
  const { client } = useAuth()
  const { shptId } = useParams<{ shptId: string }>()
  const location = useLocation()
  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch ?? ''

  const [shipment, setShipment] = useState<DispatchRow | null>(null)
  const [dispatch, setDispatch] = useState<DispatchDetailView | null>(null)
  // `dispatch === null` is TWO different states, and this page used to render
  // them identically: "the join has not answered yet" and "there is genuinely no
  // dispatch on this AWB". The join is two chained reads (the delivery report,
  // then the owning dispatch's detail), which against a remote database is well
  // over a second, and for that whole window the page asserted "No dispatch is
  // joined to this AWB" and "No courier updates for this AWB yet". Both are
  // definitive negatives about a parcel, and both were wrong while merely
  // pending: it read as a broken join and was mis-filed as one on 18 Aug 2026.
  // So the absence is only claimed once the reads have SETTLED.
  const [joinSettled, setJoinSettled] = useState(false)
  // EVERY dispatch on this AWB, not just one (18 Aug 2026, at the user's
  // correction). One shpt row carries no foreign key back to a dispatch at
  // all (services/fulfillment/prisma/schema.prisma's Shpt model); the link is
  // owned from the OTHER side, by however many units/collateral legs point
  // AT it (`unit.shipment`, `pending_pool_entry.collateral_shipment`), so one
  // AWB genuinely can carry several dispatches, a consolidated pickup being
  // the ordinary case, not an edge case. The lookup below used to keep only
  // the FIRST report row matching this shpt id and silently dropped the rest,
  // which is exactly what made a multi-dispatch AWB look like it held one
  // parcel.
  const [owners, setOwners] = useState<readonly ReportRow[]>([])
  const [vendors, setVendors] = useState<readonly VendorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const [overriding, setOverriding] = useState(false)

  const load = useCallback(async () => {
    if (shptId === undefined) return
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const list = await getDispatches(client)
      const hit = Array.isArray(list) ? (list.find((s) => s.id === shptId) ?? null) : null
      if (hit === null) {
        setNotFound(true)
        return
      }
      setShipment(hit)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this shipment.')
    } finally {
      setLoading(false)
    }
  }, [client, shptId])

  useEffect(() => {
    void load()
  }, [load])

  // After a correction or override lands: the list read refreshes the parcel's
  // own status row, and the new `shipment` object re-fires the trail effect
  // below, so the event the operator just wrote appears in the history.
  const refresh = useCallback(() => {
    setDispatch(null)
    setOwners([])
    setJoinSettled(false)
    void load()
  }, [load])

  // The owning dispatch, and with it this shipment's own status trail. Silent on
  // failure: the parcel's own facts above do not depend on it.
  useEffect(() => {
    if (shipment === null || shptId === undefined) return
    let cancelled = false
    // Settled means "we now know whether this AWB has an owning dispatch",
    // whichever way it came out: no matching report row, a detail read that
    // answered, or a read that failed. Only a CANCELLED run leaves it unsettled,
    // because the run that replaced it is about to answer the same question.
    const settle = (): void => {
      if (!cancelled) setJoinSettled(true)
    }
    getReport(client, 'soundbox-delivery', {})
      .then((result) => {
        if (cancelled || !Array.isArray(result.rows)) return
        // ALL of them, not the first: several dispatches can legitimately
        // travel under one AWB (a consolidated pickup), and dropping the rest
        // is what made a multi-dispatch shipment look like a single parcel.
        const matches = result.rows.filter((r) => reportRowShptId(r) === shptId)
        setOwners(matches)
        // The courier trail itself is the SAME regardless of which owner
        // answers it: status lives on the shpt row, not per dispatch, so any
        // one of them resolves the identical shipment detail.
        const dispatchId = typeof matches[0]?.dispatchId === 'string' ? matches[0].dispatchId : null
        if (dispatchId === null) return
        return getDispatchDetail(client, dispatchId).then((d) => {
          if (!cancelled) setDispatch(d)
        })
      })
      .catch(() => {})
      .finally(settle)
    getVendors(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setVendors(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, shipment, shptId])

  // The parcel's position on the courier ladder, as the same horizontal rail
  // the device and dispatch pages use: the summary at a glance, with the
  // detailed two-clock trail kept below it. Built from the shipment row itself
  // so it renders even for a collateral-only parcel with no dispatch join;
  // rung times come from the trail when the join exists.
  const rail = useMemo<RailStage[]>(() => {
    if (shipment === null) return []
    return buildShipmentRail(shipment, dispatch)
  }, [shipment, dispatch])

  const stages = useMemo<{ stages: TimelineStage[]; terminal: TimelineTerminal | null }>(() => {
    if (dispatch === null) return { stages: [], terminal: null }
    const events: TimelineStage[] = dispatch.deliveryTrail.map((e, i) => ({
      key: `evt-${String(i)}-${e.status}`,
      label: statusMeta(e.status).label,
      state: i === dispatch.deliveryTrail.length - 1 ? 'current' : 'reached',
      at: e.courierTimestamp,
      atLabel: 'reported',
      source: `${e.statusSource}, recorded ${fmtDateTime(e.receivedAt)}`,
      note: e.overrideReason === null ? undefined : 'operator override',
      sub: e.overrideReason === null ? undefined : `Override: ${e.overrideReason}`,
    }))
    const last = dispatch.deliveryTrail.at(-1) ?? null
    // RETURNED closes the parcel. FAILED does not: a failed attempt can be
    // re-attempted and still deliver.
    const terminal: TimelineTerminal | null =
      last !== null && last.status === 'RETURNED'
        ? {
            label: 'Returned to origin',
            sub: 'the parcel came back; a re-dispatch is a separate decision.',
            at: last.courierTimestamp,
          }
        : null
    return { stages: terminal === null ? events : events.slice(0, -1), terminal }
  }, [dispatch])

  if (loading) return <SkeletonRows rows={6} />
  if (error !== null) return <ErrorNote>{error}</ErrorNote>
  if (notFound || shipment === null) {
    return (
      <div className="space-y-4">
        <BackLink to="/shipments" label="Shipments" fromSearch={fromSearch} />
        <EmptyState title="No such shipment" message="The id in the address does not name a shipment." />
      </div>
    )
  }

  const courierName =
    shipment.courierPartner === null
      ? null
      : (vendors.find((v) => v.id === shipment.courierPartner)?.displayName ?? shipment.courierPartner)

  function contents(): string {
    if (shipment!.hasUnits && shipment!.hasCollateral) return 'Devices and collateral'
    if (shipment!.hasUnits) return 'Devices'
    if (shipment!.hasCollateral) return 'Collateral'
    return 'Nothing linked yet'
  }

  return (
    <div className="space-y-4">
      <BackLink to="/shipments" label="Shipments" fromSearch={fromSearch} />

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="num text-xl font-semibold tracking-tight">{shipment.awb}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One AWB, one parcel. <CodeChip>{shipment.id}</CodeChip>
          </p>
        </div>
        <div className="ml-auto">
          <StatusPill value={shipment.status} />
        </div>
      </div>

      <Card>
        <CardBody>
          <div className="pb-5">
            <h2 className="text-base font-medium">Shipment lifecycle</h2>
            <p className="text-[12.5px] text-muted-foreground">
              The courier ladder for this parcel. The full event history, with both clocks, is below.
            </p>
          </div>
          <LifecycleRail stages={rail} />
        </CardBody>
      </Card>

      {/* items-stretch, not items-start (18 Aug 2026, at the user's
          correction): the carrier-history card is usually the shorter of the
          two, and a half-height card beside a full one read as unfinished
          rather than as an empty answer. */}
      <div className="grid gap-4 lg:grid-cols-[384px_minmax(0,1fr)] lg:items-stretch">
        <Card>
          <CardBody>
            <SectionHeading>Parcel</SectionHeading>
            <FactRow icon={Truck} label="Courier">
              {courierName ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={Boxes} label="Contents">
              {contents()}
            </FactRow>
            <FactRow icon={Calendar} label="Dispatched">
              {fmtDateTime(shipment.dispatchDate)}
            </FactRow>
            <FactRow icon={Calendar} label="Last update">
              {shipment.statusAt === null ? <NoValue>none yet</NoValue> : fmtDateTime(shipment.statusAt)}
            </FactRow>
            <FactRow icon={Radio} label="Reported by">
              {shipment.statusSource ?? <NoValue>not recorded</NoValue>}
            </FactRow>

            <SectionHeading>What is inside</SectionHeading>
            {owners.length === 0 && !joinSettled ? (
              <p className="py-1.5 text-sm text-muted-foreground">Looking up the dispatches on this AWB…</p>
            ) : owners.length === 0 ? (
              <p className="py-1.5 text-sm text-muted-foreground">
                No dispatch is joined to this AWB in the reporting rail. A collateral-only parcel is tracked here but
                carries no soundbox dispatch to open.
              </p>
            ) : (
              // A TABLE, not a single fact row (18 Aug 2026, at the user's
              // correction): one AWB can carry several dispatches, a
              // consolidated pickup being the ordinary case, and a single
              // "Merchant" / "Dispatch" pair silently named only the first one
              // and hid the rest.
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-muted-foreground">
                      <th className="px-1 pb-1.5 font-normal">Dispatch</th>
                      <th className="px-1 pb-1.5 font-normal">Merchant</th>
                    </tr>
                  </thead>
                  <tbody>
                    {owners.map((row) => {
                      const dispatchId = typeof row.dispatchId === 'string' ? row.dispatchId : null
                      const merchant = typeof row.merchantDisplay === 'string' ? row.merchantDisplay : null
                      if (dispatchId === null) return null
                      return (
                        <tr key={dispatchId} className="border-t">
                          <td className="px-1 py-1.5">
                            <Link className="underline underline-offset-2" to={`/dispatches/${dispatchId}`}>
                              <CodeChip>{dispatchId}</CodeChip>
                            </Link>
                          </td>
                          <td className="px-1 py-1.5">{merchant ?? <NoValue>not recorded</NoValue>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <Card className="max-w-2xl">
          {/* flex-col so the timeline below can grow into the card's full
              height, which is what makes the centered empty state sit in the
              middle rather than hugging the description. */}
          <CardBody className="flex h-full flex-col">
            <div className="flex flex-wrap items-start justify-between gap-3 pb-2">
              <h2 className="text-base font-medium">Carrier history</h2>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCorrecting(true)}>
                  Record courier update
                </Button>
                {/* Only at a terminal: everywhere else the routine tool covers
                    every legal move, and a bypass on screen would only invite
                    bypassing. */}
                {(shipment.status === 'DELIVERED' || shipment.status === 'RETURNED') && (
                  <Button variant="danger" size="sm" onClick={() => setOverriding(true)}>
                    Override
                  </Button>
                )}
              </div>
            </div>
            <p className="mb-4 text-[12.5px] text-muted-foreground">
              Every courier update for this parcel, oldest first, with when the courier reported it and when we
              recorded it.
            </p>
            <div className="flex grow flex-col justify-center">
              <LifecycleTimeline
                stages={stages.stages}
                terminal={stages.terminal}
                // The centered empty state only once the reads have SETTLED. A
                // pending join is not an absent trail, so mid-load stays a
                // plain sentence (no emptyTitle) rather than a confident
                // "nothing here" panel.
                {...(joinSettled ? { emptyTitle: 'No courier updates yet' } : {})}
                emptyMessage={
                  joinSettled
                    ? 'The courier has not reported on this AWB. Record one with the button above once they do.'
                    : 'Loading the courier history…'
                }
              />
            </div>
          </CardBody>
        </Card>
      </div>

      <CorrectStatusDialog
        shptId={shipment.id}
        awb={shipment.awb}
        open={correcting}
        onOpenChange={setCorrecting}
        onSaved={refresh}
      />
      <OverrideStatusDialog
        shptId={shipment.id}
        awb={shipment.awb}
        open={overriding}
        onOpenChange={setOverriding}
        onSaved={refresh}
      />
    </div>
  )
}

/** The courier ladder (FR-06). Order IS the journey. */
const SHIPMENT_LADDER = [
  { key: 'DISPATCHED_BY_VENDOR', label: 'Dispatched by vendor', icon: Truck },
  { key: 'PICKED_UP', label: 'Picked up', icon: PackageOpen },
  { key: 'IN_TRANSIT', label: 'In transit', icon: Route },
  { key: 'OUT_FOR_DELIVERY', label: 'Out for delivery', icon: Bike },
  { key: 'DELIVERED', label: 'Delivered', icon: PackageCheck },
] as const

/**
 * Where each courier status sits on the five rungs above: the shared
 * SHIPMENT_RUNG, which mirrors the service's own LADDER_RANK.
 *
 * THIS PAGE SHOWS ALL FIVE, and that is the point (19 Aug 2026). It listed only
 * three rung names by hand, and everything absent from the map was treated as
 * off-ladder and drawn as a red terminal stop, so PICKED_UP and
 * OUT_FOR_DELIVERY - both offered by this page's OWN correction dialog - turned a
 * live parcel into a failure. The first fix folded them onto their neighbours,
 * which stopped the red stop but produced a subtler lie: pick OUT_FOR_DELIVERY
 * and the rail lights up "In transit".
 *
 * So the rule is now explicit. The DISPATCH page compresses the courier axis onto
 * the BRD's three courier rungs, because it is summarising a seven-rung ladder.
 * THIS page owns the courier axis and shows it whole, because a detail view that
 * hides two of its subject's own states is not a detail view.
 */
const LADDER_POS: Record<string, number> = SHIPMENT_RUNG

/**
 * RETURNED closes the rail in red. FAILED renders as a red stop too, but
 * Delivered stays ahead of it as a future rung: a failed attempt can be
 * re-attempted and still deliver, so the ladder is not over.
 */
function buildShipmentRail(shipment: DispatchRow, dispatch: DispatchDetailView | null): RailStage[] {
  const trail = dispatch?.deliveryTrail ?? []
  const offLadder = isOffLadder(shipment.status)
  // Off the ladder, the parcel's proven progress is the furthest ordinary rung
  // any trail event reached; a shipment row alone proves only the dispatch.
  const currentIdx = offLadder
    ? trail.reduce((max, e) => Math.max(max, LADDER_POS[e.status] ?? 0), 0)
    : (LADDER_POS[shipment.status] ?? 0)

  const rungTime = (key: string): string | null => {
    const fromTrail = trail.reduce<string | null>(
      (latest, e) => (e.status === key ? e.courierTimestamp : latest),
      null,
    )
    // Without the dispatch join there is no trail; the row's own statusAt is
    // still a real instant for the status the row currently holds.
    if (fromTrail === null && !offLadder && key === shipment.status) return shipment.statusAt
    return fromTrail
  }

  const stages: RailStage[] = SHIPMENT_LADDER.map((rung, i) => ({
    key: rung.key,
    label: rung.label,
    icon: rung.icon,
    state: i < currentIdx ? 'reached' : i === currentIdx ? (offLadder ? 'reached' : 'current') : 'future',
    at: i <= currentIdx ? rungTime(rung.key) : null,
  }))

  if (offLadder) {
    stages.push({
      key: shipment.status,
      label: shipment.status === 'RETURNED' ? 'Returned to origin' : statusMeta(shipment.status).label,
      icon: shipment.status === 'RETURNED' ? Undo2 : AlertTriangle,
      state: 'current',
      at: shipment.statusAt,
      terminal: true,
    })
  }
  return stages
}
