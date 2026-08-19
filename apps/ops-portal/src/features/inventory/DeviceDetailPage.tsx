import { useEffect, useMemo, useState } from 'react'
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
  getMerchants,
  getVendors,
  type UnitInventoryRow,
  type MerchantRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { Card, CardBody, Button, ErrorNote, StatusPill, CodeChip, Spinner } from '../../ui/primitives.js'
import { LifecycleRail, type RailStage } from '../../ui/LifecycleRail.js'
import { BackLink, FactRow, SectionHeading } from '../../ui/DetailFacts.js'
import { fmtDateTime } from '../../ui/format.js'
import { useToast } from '../../ui/Toast.js'
import { UnitStatusEditDialog } from './UnitStatusEditDialog.js'
import { UNIT_SPINE, STAGE_COPY, legalNextStatuses, isTerminalStatus, statusLabel } from './unitStatus.js'

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

function buildRail(row: UnitInventoryRow): RailStage[] {
  const terminal = isTerminalStatus(row.status) ? row.status : null

  // On the spine, position is exact. On a terminal branch the row's own links
  // prove how far it got; anything beyond that is unknown and stays unreached.
  const currentIdx =
    terminal === null
      ? UNIT_SPINE.indexOf(row.status as (typeof UNIT_SPINE)[number])
      : row.shipment !== null
        ? UNIT_SPINE.indexOf('DISPATCHED')
        : row.printedForMerchant !== null
          ? UNIT_SPINE.indexOf('PRINTED')
          : UNIT_SPINE.indexOf('IN_STOCK')

  const stages: RailStage[] = UNIT_SPINE.map((key, i) => ({
    key,
    label: STAGE_COPY[key]?.label ?? key,
    icon: STAGE_ICON[key] ?? Box,
    state: i < currentIdx ? 'reached' : i === currentIdx ? (terminal === null ? 'current' : 'reached') : 'future',
    // Only the current rung can be dated: updatedAt is when the row last
    // moved, which is this stage and no other.
    at: terminal === null && i === currentIdx ? row.updatedAt : null,
  }))

  // NO ACTIVATED RUNG, as of 19 Aug 2026.
  //
  // One was pushed on here, and the reasoning given for it was the argument
  // AGAINST it: activation is a separate axis (unit.activated_at, D-16), so a
  // device can be activated while its delivery is still outstanding. Put that on
  // one ordered rail and the rail stops being ordered. It rendered, on real demo
  // data, as
  //
  //     ... Dispatched (done) -> Delivered (NOT reached) -> Activated (done)
  //         -> Returned (terminal)
  //
  // which is not a sequence at all, and it contradicted this page's own Change
  // status dialog, which correctly refuses to offer ACTIVATED because the server
  // does not accept it as a status.
  //
  // The fact is not lost, it moved to where it belongs: a PILL in the page
  // header beside the status pill, which is exactly how the inventory table
  // already models it (an Activation column and a Status column, two axes, two
  // cells). The exact instant stays on the Activity card. So the rail is the
  // delivery spine alone, and the two axes read the same way in the list and on
  // the page.
  if (terminal !== null) {
    stages.push({
      key: terminal,
      label: STAGE_COPY[terminal]?.label ?? terminal,
      icon: STAGE_ICON[terminal] ?? AlertTriangle,
      state: 'current',
      at: row.updatedAt,
      terminal: true,
    })
  }
  return stages
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

  const [statusOpen, setStatusOpen] = useState(false)

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
  const rail = useMemo(() => (row === null ? null : buildRail(row)), [row])

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
  const canMove = legalNextStatuses(row.status).length > 0

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
        {/* TWO AXES, TWO PILLS, in the same order the inventory table's columns
            use them (Activation, then Status). Activation was a rung on the rail
            below until 19 Aug 2026; buildRail records why it could never be one.
            A device that has not been activated says so rather than going quiet,
            because on a delivered device that absence is the thing an operator
            came to check. */}
        <div className="ml-auto flex items-center gap-2">
          <StatusPill value={row.activatedAt !== null ? 'ACTIVATED' : 'NOT_ACTIVATED'} />
          <StatusPill value={row.status} />
        </div>
      </div>

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3 pb-5">
            <div>
              <h2 className="text-base font-medium">Device lifecycle</h2>
              <p className="text-[12.5px] text-muted-foreground">
                A device only moves forward. Once it is marked damaged, it cannot be reverted.
              </p>
            </div>
            {/* The status action lives HERE, on the thing it changes. */}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setStatusOpen(true)}
              disabled={!canMove}
              title={canMove ? undefined : 'This device cannot be reverted'}
            >
              Change status
            </Button>
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

      <UnitStatusEditDialog
        unit={row}
        open={statusOpen}
        onOpenChange={setStatusOpen}
        onSaved={(status) => setRow({ ...row, status })}
      />
    </div>
  )
}
