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
  getDeviceTrail,
  getMerchants,
  getVendors,
  type UnitInventoryRow,
  type MerchantRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { Card, CardBody, Button, ErrorNote, StatusPill, CodeChip, Spinner } from '../../ui/primitives.js'
import { LifecycleRail, type RailStage } from '../../ui/LifecycleRail.js'
import { buildRailFromTrail, deviceDisplayStatus } from '../../ui/statusRail.js'
import type { StatusTrailEntry } from '../../api/endpoints.js'
import { BackLink, FactRow, SectionHeading } from '../../ui/DetailFacts.js'
import { fmtDateTime } from '../../ui/format.js'
import { useToast } from '../../ui/Toast.js'
import { UnitStatusEditDialog } from './UnitStatusEditDialog.js'
import {
  UNIT_SPINE,
  UNIT_TERMINAL,
  STAGE_COPY,
  legalNextStatuses,
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
function buildRail(trail: readonly StatusTrailEntry[]): RailStage[] {
  return buildRailFromTrail({
    spine: UNIT_SPINE,
    terminals: UNIT_TERMINAL,
    trail,
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

  const [statusOpen, setStatusOpen] = useState(false)

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
  }, [client, unitId, statusOpen])

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
  const rail = useMemo(() => (row === null ? null : buildRail(trail)), [row, trail])

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
        {/* ONE COMPOSED PILL (STATUS_STAGES.md, 21 Aug 2026), not two.
            The two axes stay separate in storage for the reason buildRail
            records, but the team ruled the SCREEN should read as one
            lifecycle, so deviceDisplayStatus composes them: COMPLETED means
            delivered and live, and a terminal outcome outranks both.

            This also retires a `NOT_ACTIVATED` pill that was never a backend
            value at all. The absence it existed to surface still matters on a
            delivered device, so it is stated in words below rather than
            dressed up as a status the platform does not store. */}
        <div className="ml-auto flex items-center gap-2">
          {row.status === 'DELIVERED' && row.activatedAt === null && (
            <span className="text-[12px] text-muted-foreground">Not activated yet</span>
          )}
          <StatusPill
            value={deviceDisplayStatus({
              status: row.status,
              activatedAt: row.activatedAt,
              terminals: UNIT_TERMINAL,
            })}
          />
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
