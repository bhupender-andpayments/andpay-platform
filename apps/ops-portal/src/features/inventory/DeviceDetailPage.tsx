import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Box,
  Building2,
  Calendar,
  Check,
  Copy,
  Factory,
  MapPin,
  PackageCheck,
  Printer,
  QrCode,
  Repeat,
  Smartphone,
  Store,
  Truck,
  Undo2,
  Warehouse,
  Zap,
} from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getDevices,
  getDeviceTrail,
  getMerchants,
  getVendors,
  type UnitInventoryRow,
  type MerchantRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { Card, CardBody, Button, ErrorNote, StatusPill, CodeChip, Spinner } from '../../ui/primitives.js'
import { LifecycleRail, type RailStage } from '../../ui/LifecycleRail.js'
import { buildRailFromTrail } from '../../ui/statusRail.js'
import { getDeviceReplacementChain, type UnitReplacementChain } from '../../api/endpoints.js'
import type { StatusTrailEntry } from '../../api/endpoints.js'
import { BackLink, FactRow, SectionHeading } from '../../ui/DetailFacts.js'
import { fmtDateTime } from '../../ui/format.js'
import { useToast } from '../../ui/Toast.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { markActivated, deactivateAssignment } from '../../api/endpoints.js'
import {
  UNIT_SPINE,
  UNIT_TERMINAL,
  STAGE_COPY,
  statusLabel,
} from './unitStatus.js'

// One device, end to end. The lifecycle owns the top of the page as a
// horizontal rail, and the facts sit under it in three cards.
//
// WHY THE RAIL IS ON TOP. "Where has this device reached" is the question the
// page is opened to answer, and the old layout answered it in a vertical list
// down the right-hand side while the left column ran out of content halfway,
// leaving a tall empty gap. A rail reads left to right in one glance and the
// three cards below fill the width evenly.
//
// THE RAIL IS HONEST ABOUT WHAT IT KNOWS, unchanged from the timeline it
// replaces: `unit` carries only its current status and updatedAt, with no
// per-stage history table, so past rungs show as reached with NO timestamp
// rather than an invented one. Only the current rung, and a terminal stop, are
// dated. A reference mockup for this page showed a distinct time under every
// past stage; the data to fill that in does not exist, so it is not drawn.
//
// A terminal DAMAGED/RETURNED device shows the spine as far as the row's own
// links prove it got (a shipment proves DISPATCHED, a printed-for merchant
// proves PRINTED) and then the terminal stop: phase 1 closes a damaged device
// permanently, and the server's state machine enforces exactly that.
//
// TWO SEPARATE EDIT ACTIONS, deliberately. "Change status" sits on the rail,
// because status is what the rail shows and moving it is a lifecycle event.
// "Edit device details" sits on the Device card, because it corrects what the
// intake file recorded. Folding them into one form would put an irreversible
// lifecycle move one tab away from fixing a typo.
//
// There is no third "Mark damaged" button (removed 2026-08-14). DAMAGED is one
// of the choices "Change status" already offers, and a second button for one
// value of one dropdown put an irreversible write on the screen twice.
//
// The manufacturer QR card is gone (2026-08-14): a raw payload blob nobody
// eyeballs, taking a card's worth of space on the page an operator opens to
// check a device's progress.

const STAGE_ICON: Record<string, RailStage['icon']> = {
  IN_STOCK: Warehouse,
  PRINTED: Printer,
  DISPATCHED: Truck,
  DELIVERED: PackageCheck,
  DAMAGED: AlertTriangle,
  RETURNED: Undo2,
}

// THE RAIL COMES FROM THE DEVICE'S TRAIL (STATUS_STAGES.md, 21 Aug 2026).
//
// This replaces a rank comparison that claimed every rung below the current one
// had been reached, and that dated only the current rung because `unit` kept no
// per-stage history. It keeps none still: the history lives in
// unit_status_event, which this page now reads, so every reached rung carries
// its own real instant and a skipped rung reads as skipped.
//
// The activation axis stays OFF the rail, unchanged and for the unchanged
// reason (recorded at length below): a device can be activated while its
// delivery is still outstanding, so putting activation on one ordered rail
// stops the rail being ordered. It shows as a pill in the header instead.
//
// An EMPTY trail is a real state, not an error: a device whose status has not
// moved since the trails were created has only its backfilled starting rung.
// The rail then shows that rung and the rest of the spine greyed ahead of it,
// which is exactly right.
function buildRail(trail: readonly StatusTrailEntry[], currentStatus: string): RailStage[] {
  return buildRailFromTrail({
    spine: UNIT_SPINE,
    terminals: UNIT_TERMINAL,
    trail,
    // unit.status is the authority on whether this device is ACTUALLY on a
    // terminal branch. Without it the rail read a cancelled damage flag still
    // in the trail as the device's end state (23 Aug 2026).
    currentStatus,
    label: (k) => STAGE_COPY[k]?.label ?? k,
    icon: (k) => STAGE_ICON[k] ?? Box,
  })
}

export function DeviceDetailPage() {
  const { unitId } = useParams<{ unitId: string }>()
  const { client } = useAuth()
  const location = useLocation()
  const { toast } = useToast()

  const handedRow = (location.state as { row?: UnitInventoryRow; fromSearch?: string } | null)?.row
  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch ?? ''

  const [row, setRow] = useState<UnitInventoryRow | null>(handedRow ?? null)
  const [loading, setLoading] = useState(handedRow === undefined || handedRow === null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [merchantNames, setMerchantNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [vendors, setVendors] = useState<readonly VendorRow[]>([])
  const [copied, setCopied] = useState(false)


  // THE ACTIVATION TOGGLE (23 Aug 2026, at the user's direction). Activate and
  // Deactivate both live HERE, on the device's own page beside the pill that
  // shows the value, each behind a confirm. The Undo that used to sit on the
  // activation batch list is gone: its click also fired the row's navigation,
  // and its instant reload re-read a projection the fact had not reached.
  //
  // THE WRITE AND THE READ ARE IN DIFFERENT CONTEXTS, so the handler WAITS.
  // Activation is written on tms.assignment; this page renders
  // fulfillment.unit.activated_at, which follows via the activated/deactivated
  // fact and the fulfillment consumer. An immediate re-read shows the OLD value
  // and reads as "nothing happened" (the exact complaint that killed the old
  // Undo).
  //
  // THE WRITE'S ANSWER IS APPLIED DIRECTLY (23 Aug 2026). This used to block on
  // a poll: sleep 700ms, re-read the device list, repeat up to eight times. It
  // was correct and it FELT BROKEN, reported as "that API is slow, it takes
  // more time" - the 700ms was mine, not the platform's; the domain write
  // itself measures ~2ms. Nothing was being waited FOR, either: TMS is the
  // system of record for activation, so a 200 from the write already IS the
  // new state, and reading fulfillment back was asking a slower copy to
  // confirm what the owner had already said.
  //
  // So the row flips the moment the write returns, and a convergence pass runs
  // in the BACKGROUND to swap the local value for the projected one once it
  // lands. That pass may only ever move the row TOWARDS agreement: a read that
  // still shows the old value is a lagging copy, never a reason to un-flip
  // what TMS has committed.
  const [activationOpen, setActivationOpen] = useState(false)
  const [activationBusy, setActivationBusy] = useState(false)
  const [activationError, setActivationError] = useState<string | null>(null)
  // The convergence pass outlives a fast navigation away, so it checks this
  // before touching state rather than writing into an unmounted component.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function toggleActivation(): Promise<void> {
    if (row === null || row.asgnId === null) return
    const deactivating = row.activatedAt !== null
    setActivationBusy(true)
    setActivationError(null)
    try {
      if (deactivating) await deactivateAssignment(client, row.asgnId, newIdempotencyKey())
      else await markActivated(client, row.asgnId, newIdempotencyKey())
    } catch (err) {
      setActivationError(err instanceof Error ? err.message : 'Could not update the activation.')
      setActivationBusy(false)
      return
    }
    // Committed. Show it, close, and stop spinning: everything past this point
    // is the slower copy catching up, and the operator should not be made to
    // watch it happen.
    setRow((prev) => (prev === null ? prev : { ...prev, activatedAt: deactivating ? null : new Date().toISOString() }))
    setActivationOpen(false)
    setActivationBusy(false)
    toast(deactivating ? 'Activation withdrawn.' : 'Device activated.')

    void (async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (!mounted.current) return
        const list = await getDevices(client).catch(() => null)
        const hit = Array.isArray(list) ? (list.find((d) => d.id === unitId) ?? null) : null
        // Only when it AGREES. Adopting a row that still disagrees is exactly
        // how the old code made a committed write look undone.
        if (hit !== null && (hit.activatedAt !== null) !== deactivating) {
          if (mounted.current) setRow(hit)
          return
        }
      }
    })()
  }

  // The device's status trail, which the rail is built from. Silent on failure
  // like the other supporting reads on this page: a trail that does not arrive
  // costs the rail its dates, not the page.
  const [trail, setTrail] = useState<readonly StatusTrailEntry[]>([])

  // Direct-URL entry (no handed row): recover the row from the list read, the
  // same wire the table uses.
  //
  // `row` IS DELIBERATELY NOT A DEPENDENCY: with it, this effect re-ran the
  // moment its own `setRow` landed and cancelled its own in-flight work. The
  // deps below are all stable, so the effect runs once per real mount.
  //
  // AND THERE IS DELIBERATELY NO one-shot ref GUARD. One used to sit here, and
  // under StrictMode (main.tsx) it made every link into this page spin
  // forever: the first mount's effect set the ref and started the fetch, its
  // cleanup set `cancelled` so the response was thrown away, and the second
  // mount's effect was then blocked by the ref, so nothing ever called
  // setLoading(false). A remount re-running the fetch is the correct behavior,
  // and `cancelled` already keeps the stale response from racing the fresh one.
  useEffect(() => {
    if (handedRow !== undefined && handedRow !== null) return
    if (unitId === undefined) return
    let cancelled = false
    getDevices(client)
      .then((list) => {
        if (cancelled) return
        const hit = Array.isArray(list) ? (list.find((d) => d.id === unitId) ?? null) : null
        setRow(hit)
        if (hit === null) setLoadError('No device with this id exists.')
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load the device.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, unitId, handedRow])

  // The trail. Refetched when the status dialog closes, so a correction an
  // operator just made shows on the rail without a page reload.
  useEffect(() => {
    if (unitId === undefined) return
    let cancelled = false
    getDeviceTrail(client, unitId)
      .then((rows) => {
        if (!cancelled) setTrail(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        if (!cancelled) setTrail([])
      })
    return () => {
      cancelled = true
    }
    // `statusOpen` used to be a dependency here so the trail re-read when the
    // status dialog closed. That dialog is gone (the rail is a read now), so
    // the trail follows the device id alone.
  }, [client, unitId])

  // BOTH ENDS OF THE REPLACEMENT CHAIN (23 Aug 2026), from this device's own
  // detail read.
  //
  // It used to ask the DISPATCH endpoint for one direction and render the
  // parent id in a `title` tooltip, so the answer was invisible unless you
  // happened to hover, and the forward direction ("this one was damaged, what
  // went out instead") had no answer anywhere on the page.
  //
  // A NARROW route of its own, NOT getDeviceDetail: that one serves the raw
  // manufacturer QR payload and this page is guarded against calling it (see
  // device-detail.test.tsx). The chain read carries ids and serials only, so
  // the guard stands.
  //
  // Silent on failure: the chain enriches the page, it does not gate it.
  const [links, setLinks] = useState<UnitReplacementChain | null>(null)
  useEffect(() => {
    if (unitId === undefined) return
    let cancelled = false
    getDeviceReplacementChain(client, unitId)
      .then((d) => {
        if (!cancelled) setLinks(d)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, unitId])

  const replacesAsgnId = links?.replacementOfAsgnId ?? null

  // Names for ids, silent on failure: a lookup that does not arrive costs a
  // label, not the page.
  useEffect(() => {
    let cancelled = false
    getMerchants(client)
      .then((list: MerchantRow[]) => {
        if (cancelled || !Array.isArray(list)) return
        setMerchantNames(new Map(list.map((m) => [m.mrchId, m.displayName])))
      })
      .catch(() => {})
    getVendors(client)
      .then((list: VendorRow[]) => {
        if (cancelled || !Array.isArray(list)) return
        setVendors(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const vendorNames = useMemo(() => new Map(vendors.map((v) => [v.id, v.displayName])), [vendors])
  const rail = useMemo(() => (row === null ? null : buildRail(trail, row.status)), [row, trail])

  async function copySerial(serial: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(serial)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast(`Copied ${serial}`)
    } catch {
      /* clipboard denied: value stays selectable */
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading device…
      </div>
    )
  }

  if (row === null) {
    return (
      <div className="space-y-4">
        <BackLink to="/inventory" label="Inventory" fromSearch={fromSearch} />
        <ErrorNote>{loadError ?? 'No device with this id exists.'}</ErrorNote>
      </div>
    )
  }

  const mfrName = row.manufacturerVndr !== null ? (vendorNames.get(row.manufacturerVndr) ?? row.manufacturerVndr) : null
  const merchantName =
    row.printedForMerchant !== null ? (merchantNames.get(row.printedForMerchant) ?? row.printedForMerchant) : null

  return (
    <div className="space-y-4">
      <BackLink to="/inventory" label="Inventory" fromSearch={fromSearch} />

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Smartphone className="size-5 text-primary" aria-hidden="true" />
        </span>
        <div>
          <h1 className="num flex items-center gap-2 text-xl font-semibold tracking-tight">
            {row.deviceSerial ?? row.id}
            {row.deviceSerial !== null && (
              <button
                type="button"
                aria-label="Copy device id"
                onClick={() => void copySerial(row.deviceSerial!)}
                className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
              >
                {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
              </button>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">{row.productType.toLowerCase()} device</p>
        </div>
        {/* TWO PILLS, ONE PER AXIS (23 Aug 2026 ruling), reverting the single
            composed COMPLETED pill this header carried since 21 Aug.

            The composition was not wrong about the domain, but it was wrong on
            this screen: COMPLETED is a word the platform stores nowhere, and it
            replaced the two values an operator is actually reconciling against
            the CWD and the courier. The inventory list has always shown them as
            two separate columns; the detail page now agrees with the list
            instead of inventing a third vocabulary for the same device.

            Order matches the list's column order: activation, then delivery.
            deviceDisplayStatus itself is retained, see its own note. */}
        <div className="ml-auto flex items-center gap-2">
          {replacesAsgnId !== null && (
            <span
              className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
              title={`This device travels on a replacement dispatch. Replaces ${replacesAsgnId}`}
            >
              Replacement
            </span>
          )}
          {row.activatedAt === null ? (
            <span className="text-[12px] text-muted-foreground">Not activated</span>
          ) : (
            <StatusPill value="ACTIVATED" />
          )}
          {/* THE ACTIVATION TOGGLE (23 Aug 2026, at the user's direction),
              beside the pill whose value it flips. Activation is not a rung on
              the forward-only status rail (a device can be activated while its
              delivery is still outstanding), so it is not one of the moves
              "Change status" offers: it is its own axis with its own control.
              Offered only on a device paired to a dispatch, because the write
              is addressed to the dispatch. */}
          {row.asgnId !== null && (
            <Button variant="secondary" size="sm" onClick={() => setActivationOpen(true)}>
              {row.activatedAt === null ? 'Activate' : 'Deactivate'}
            </Button>
          )}
          <StatusPill value={row.status} />
        </div>
      </div>

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      {/* THE REPLACEMENT CHAIN, one hop in each direction (23 Aug 2026).
          One hop and not the whole tree on purpose: the dispatch page already
          renders every generation through ReplacementChain, and a second chain
          component here would be the same idea implemented twice, free to drift.
          This answers the two questions asked OF A DEVICE ("what did this one
          replace", "what replaced this one") and links out for the rest.

          A missing device with a present dispatch is a REAL state, not a gap: a
          collateral-only replacement carries no soundbox, and a successor still
          at the print vendor has no serial paired yet. Both say so in words
          rather than rendering an empty link. */}
      {links !== null && (links.replacementOfAsgnId !== null || links.replacedByAsgnId !== null) && (
        <Card className="border-amber-300 bg-amber-500/[0.06] dark:border-amber-800 dark:bg-amber-500/10">
          <CardBody>
            <div className="flex items-start gap-2.5">
              <Repeat className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                <p className="font-medium text-foreground">Replacement chain</p>
                {links.replacementOfAsgnId !== null && (
                  <p className="text-muted-foreground">
                    This device went out to replace dispatch{' '}
                    <Link to={`/dispatches/${links.replacementOfAsgnId}`} className="underline underline-offset-2">
                      <CodeChip>{links.replacementOfAsgnId}</CodeChip>
                    </Link>
                    {links.parentDeviceId !== null ? (
                      <>
                        , whose device was{' '}
                        <Link to={`/inventory/device/${links.parentDeviceId}`} className="underline underline-offset-2">
                          <CodeChip>{links.parentDeviceSerial ?? links.parentDeviceId}</CodeChip>
                        </Link>
                        .
                      </>
                    ) : (
                      <>. That dispatch carried no device of its own (collateral only).</>
                    )}
                  </p>
                )}
                {links.replacedByAsgnId !== null && (
                  <p className="text-muted-foreground">
                    This device was replaced by dispatch{' '}
                    <Link to={`/dispatches/${links.replacedByAsgnId}`} className="underline underline-offset-2">
                      <CodeChip>{links.replacedByAsgnId}</CodeChip>
                    </Link>
                    {links.successorDeviceId !== null ? (
                      <>
                        , now carrying{' '}
                        <Link
                          to={`/inventory/device/${links.successorDeviceId}`}
                          className="underline underline-offset-2"
                        >
                          <CodeChip>{links.successorDeviceSerial ?? links.successorDeviceId}</CodeChip>
                        </Link>
                        .
                      </>
                    ) : (
                      <>. No device is paired to it yet.</>
                    )}
                  </p>
                )}
                {row.asgnId !== null && (
                  <p>
                    <Link to={`/dispatches/${row.asgnId}`} className="text-xs underline underline-offset-2">
                      View the full chain on the dispatch
                    </Link>
                  </p>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          {/* NO STATUS ACTION (24 Aug 2026, at the user's direction). THE RAIL
              IS A READ. Every rung is written by the flow that owns it: In
              stock by the manufacturer intake, At print vendor by the batch's
              send, Dispatched by the vendor's return sheet, Delivered and
              Returned by the SHIPMENT (one parcel moves all its devices in one
              transaction), and Damaged by the dispatch's Flag damage, which
              also opens the case and raises the replacement. Nothing is left
              for this page to set, so it sets nothing. Activation is the one
              device-level write and keeps its own toggle in the header. */}
          <div className="pb-5">
            <h2 className="text-base font-medium">Device lifecycle</h2>
            <p className="text-[12.5px] text-muted-foreground">
              Where this device has reached. Delivery follows its parcel; damage is raised on its dispatch.
            </p>
          </div>
          {rail !== null && <LifecycleRail stages={rail} />}
        </CardBody>
      </Card>

      {/* No `items-start`: the three cards hold different numbers of facts, and
          letting each shrink to its own content left a ragged bottom edge. Grid
          stretch keeps them one height, so the row reads as one band. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardBody>
            <SectionHeading>Device</SectionHeading>
            <FactRow icon={Smartphone} label="Device ID">
              <span className="num">{row.deviceSerial ?? '-'}</span>
            </FactRow>
            <FactRow icon={QrCode} label="SIM">
              {row.simNo !== null ? (
                <CodeChip>{row.simNo}</CodeChip>
              ) : (
                <span className="text-muted-foreground">none recorded</span>
              )}
            </FactRow>
            <FactRow icon={Factory} label="Manufacturer">
              {mfrName ?? <span className="text-muted-foreground">-</span>}
            </FactRow>
            <FactRow icon={MapPin} label="Location">
              {row.location ?? <span className="text-muted-foreground">-</span>}
            </FactRow>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionHeading>Assignment</SectionHeading>
            <FactRow icon={Store} label="Merchant">
              {merchantName ?? <span className="text-muted-foreground">unassigned</span>}
            </FactRow>
            <FactRow icon={Box} label="Batch">
              {row.batch !== null ? (
                <Link to={`/batches/${row.batch}`} className="underline underline-offset-2">
                  {row.batch}
                </Link>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </FactRow>
            <FactRow icon={Truck} label="Shipment">
              {row.shipment !== null ? (
                <CodeChip>{row.shipment}</CodeChip>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </FactRow>
            <FactRow icon={Building2} label="Dispatch">
              {row.asgnId !== null ? (
                <Link to={`/dispatches/${row.asgnId}`} className="underline underline-offset-2">
                  {row.asgnId}
                </Link>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </FactRow>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionHeading>Activity</SectionHeading>
            <FactRow icon={Calendar} label="Received">
              {fmtDateTime(row.createdAt)}
            </FactRow>
            <FactRow icon={Calendar} label="Last moved">
              <span>{fmtDateTime(row.updatedAt)}</span>
            </FactRow>
            {/* Activation is its OWN axis, not a rung on the rail: a device can
                be activated while its status still reads DISPATCHED, which is
                exactly why it was taken off the ladder. */}
            <FactRow icon={Zap} label="Activated">
              {row.activatedAt !== null ? (
                <span title={fmtDateTime(row.activatedAt)}>{fmtDateTime(row.activatedAt)}</span>
              ) : (
                <span className="text-muted-foreground">not activated</span>
              )}
            </FactRow>
            <FactRow icon={Box} label="Current status">
              {statusLabel(row.status)}
            </FactRow>
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={activationOpen}
        title={row.activatedAt === null ? 'Activate this device' : 'Withdraw this activation'}
        description={
          row.activatedAt === null
            ? 'Records that the CWD confirmed this device and its SIM. Delivery and courier status are untouched.'
            : 'Clears the activation record for this device. Delivery and courier status are untouched, and it can be activated again.'
        }
        confirmLabel={row.activatedAt === null ? 'Activate' : 'Deactivate'}
        busy={activationBusy}
        error={activationError}
        onConfirm={() => void toggleActivation()}
        onOpenChange={(open) => {
          if (!open) {
            setActivationOpen(false)
            setActivationError(null)
          }
        }}
      />

    </div>
  )
}
