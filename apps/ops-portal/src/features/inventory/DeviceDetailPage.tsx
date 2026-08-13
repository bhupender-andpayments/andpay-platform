import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import {
  ArrowLeft,
  Box,
  Building2,
  Calendar,
  Check,
  Copy,
  Factory,
  Info,
  MapPin,
  Pencil,
  QrCode,
  Smartphone,
  Store,
  Truck,
} from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getDevices,
  getDeviceDetail,
  correctUnitStatus,
  getMerchants,
  getVendors,
  type UnitInventoryRow,
  type UnitDetailRow,
  type MerchantRow,
  type VendorRow,
} from '../../api/endpoints.js'
import { Card, CardBody, Button, ErrorNote, StatusPill, CodeChip, Spinner } from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { fmtDateTime, fmtRelative } from '../../ui/format.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { useToast } from '../../ui/Toast.js'
import { cn } from '@/lib/utils'

// One device, end to end (reference layout: profile-detail, facts left,
// activity main). The page is born from the LIST row, which now carries the
// FULL SIM number (2026-08-13: masking it and gating it behind a Reveal click
// was overturned the same day it shipped - this is an internal admin console,
// and the operator's whole reason for opening the page is to cross-check the
// SIM against the source Excel). The manufacturer QR payload is the one thing
// still on-demand: it is a raw blob nobody eyeballs by default, and it is not
// on the list row at all, so the page fetches it itself (GET /ops/devices/:id)
// the moment a unit id is known - no Reveal click gates it (2026-08-13
// review): a click to see something the operator opened the page FOR was one
// more thing in the way, not a real privacy boundary the way the SIM's masking
// briefly was.
//
// THE TIMELINE IS HONEST ABOUT WHAT IT KNOWS. unit carries only the current
// status and updatedAt - there is no per-stage history table - so past rungs
// render as reached but carry no invented timestamps, and only the current
// rung shows its real instant. A terminal DAMAGED/RETURNED device shows the
// spine as far as the row's own links prove it got (a shipment proves
// DISPATCHED, a printed_for merchant proves PRINTED) and then the terminal
// stop, marked final: phase 1 closes a damaged device permanently, and the
// server's state machine (unit-lifecycle.ts) enforces exactly that.
const SPINE = ['IN_STOCK', 'ALLOCATED', 'PRINTED', 'DISPATCHED', 'DELIVERED', 'ACTIVATED'] as const
const TERMINAL: Record<string, string> = {
  DAMAGED: 'Damaged',
  RETURNED: 'Returned',
}

const STAGE_COPY: Record<string, { label: string; sub: string }> = {
  IN_STOCK: { label: 'In stock', sub: 'registered from the manufacturer file' },
  ALLOCATED: { label: 'Allocated', sub: 'reserved for a dispatch' },
  PRINTED: { label: 'Printed', sub: 'collateral printed for a merchant' },
  DISPATCHED: { label: 'Dispatched', sub: 'handed to the courier by the print vendor' },
  DELIVERED: { label: 'Delivered', sub: 'courier confirmed delivery' },
  ACTIVATED: { label: 'Activated', sub: 'live with the merchant' },
}

function FactRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Smartphone
  label: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="text-muted-foreground">{label}: </span>
        <span className="font-medium text-foreground">{children}</span>
      </div>
    </div>
  )
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <p className="pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-0">{children}</p>
}

const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In stock',
  ALLOCATED: 'Allocated',
  PRINTED: 'Printed',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  ACTIVATED: 'Activated',
  DAMAGED: 'Damaged',
  RETURNED: 'Returned',
}

// The SAME forward-only rule unit-lifecycle.ts enforces server-side
// (canAdvanceUnitStatus), mirrored here for the edit dialog's option list.
// CLIENT-SIDE CONVENIENCE ONLY: the edge is the sole authority and re-checks
// this exact rule before writing, so an option offered here that somehow
// stops being legal by submit time is rejected there, not trusted from here.
function legalNextStatuses(current: string): string[] {
  if (current === 'DAMAGED' || current === 'RETURNED') return []
  const idx = SPINE.indexOf(current as (typeof SPINE)[number])
  const forwardSpine = idx === -1 ? [] : SPINE.slice(idx + 1)
  return [...forwardSpine, 'DAMAGED', 'RETURNED']
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

  const [detail, setDetail] = useState<UnitDetailRow | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const [merchantNames, setMerchantNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [vendorNames, setVendorNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [copied, setCopied] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [newStatus, setNewStatus] = useState('')
  const [savingStatus, setSavingStatus] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  // Direct-URL entry (no handed row): recover the row from the list read, the
  // same masked wire the table uses. NOT the detail read - landing on the page
  // must not silently reveal what the operator did not ask for.
  //
  // `row` IS DELIBERATELY NOT A DEPENDENCY, and a ref guards the one-shot
  // instead. With `row` in the deps this effect re-ran the moment its own
  // `setRow` landed, and React flushed that render (running this cleanup, so
  // `cancelled` became true) BETWEEN the promise's `.then` and its `.finally`.
  // The `.finally` then skipped `setLoading(false)` and the page sat on
  // "Loading device..." forever, holding a row it had already fetched. Found by
  // the direct-URL test.
  const listRecoveryAttempted = useRef(false)
  useEffect(() => {
    if (handedRow !== undefined && handedRow !== null) return
    if (listRecoveryAttempted.current || unitId === undefined) return
    listRecoveryAttempted.current = true
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
        setVendorNames(new Map(list.map((v) => [v.id, v.displayName])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  // Fetches the manufacturer QR payload automatically once a unit id is
  // known - no click gates it (see the header comment). Runs once per
  // unitId; a failure here does not block anything else on the page.
  useEffect(() => {
    if (unitId === undefined) return
    let cancelled = false
    setDetailLoading(true)
    setDetailError(null)
    getDeviceDetail(client, unitId)
      .then(async (d) => {
        if (cancelled) return
        setDetail(d)
        const raw = extractQrRaw(d.deviceQr)
        if (raw !== null) {
          try {
            const url = await QRCode.toDataURL(raw, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
            if (!cancelled) setQrDataUrl(url)
          } catch {
            if (!cancelled) setQrDataUrl(null)
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : 'Failed to load the manufacturer QR payload.')
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, unitId])

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

  function openEdit(): void {
    if (row === null) return
    const options = legalNextStatuses(row.status)
    setNewStatus(options[0] ?? '')
    setStatusError(null)
    setEditOpen(true)
  }

  async function saveStatus(): Promise<void> {
    if (row === null || newStatus === '') return
    setSavingStatus(true)
    setStatusError(null)
    try {
      await correctUnitStatus(client, row.id, newStatus, newIdempotencyKey())
      setRow({ ...row, status: newStatus })
      setEditOpen(false)
      toast(`Status updated to ${STATUS_LABEL[newStatus] ?? newStatus}`)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to update the status.')
    } finally {
      setSavingStatus(false)
    }
  }

  const timeline = useMemo(() => (row === null ? null : buildTimeline(row)), [row])

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
        <BackLink fromSearch={fromSearch} />
        <ErrorNote>{loadError ?? 'No device with this id exists.'}</ErrorNote>
      </div>
    )
  }

  const mfrName = row.manufacturerVndr !== null ? (vendorNames.get(row.manufacturerVndr) ?? row.manufacturerVndr) : null
  const merchantName =
    row.printedForMerchant !== null ? (merchantNames.get(row.printedForMerchant) ?? row.printedForMerchant) : null

  return (
    <div className="space-y-4">
      <BackLink fromSearch={fromSearch} />

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
        <div className="ml-auto flex items-center gap-2">
          <StatusPill value={row.status} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Change status"
                onClick={openEdit}
                disabled={legalNextStatuses(row.status).length === 0}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <Pencil className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {legalNextStatuses(row.status).length === 0 ? 'This device cannot be reverted' : 'Change status'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {loadError !== null && <ErrorNote>{loadError}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-[384px_minmax(0,1fr)] lg:items-start">
        {/* Left column: the About card, then the QR card stacked directly
            below it at the same width (2026-08-13 review: the QR card was
            briefly full-width below both columns, which stranded it in a
            mostly-empty row; it belongs in the left column, sized like the
            card above it, not spanning the page). */}
        <div className="space-y-4">
        <Card>
          <CardBody>
            <SectionHeading>Device</SectionHeading>
            <FactRow icon={Smartphone} label="Device ID">
              <span className="num">{row.deviceSerial ?? '-'}</span>
            </FactRow>
            <FactRow icon={QrCode} label="SIM">
              {row.simNo !== null ? <CodeChip>{row.simNo}</CodeChip> : <span className="text-muted-foreground">none recorded</span>}
            </FactRow>
            <FactRow icon={Factory} label="Manufacturer">
              {mfrName ?? <span className="text-muted-foreground">-</span>}
            </FactRow>
            <FactRow icon={MapPin} label="Location">
              {row.location ?? <span className="text-muted-foreground">-</span>}
            </FactRow>
            <FactRow icon={Calendar} label="Received">
              {fmtDateTime(row.createdAt)}
            </FactRow>
            <FactRow icon={Calendar} label="Last moved">
              {fmtDateTime(row.updatedAt)}
            </FactRow>

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
              {row.shipment !== null ? <CodeChip>{row.shipment}</CodeChip> : <span className="text-muted-foreground">-</span>}
            </FactRow>
            <FactRow icon={Building2} label="Dispatch">
              {row.asgnId !== null ? <CodeChip>{row.asgnId}</CodeChip> : <span className="text-muted-foreground">-</span>}
            </FactRow>
          </CardBody>
        </Card>

        {/* QR card, stacked below the facts card in the SAME left column
            (2026-08-13 review, reverted from an earlier full-width row that
            left a mostly-empty gap): the QR is a manufacturer artifact an
            operator glances at occasionally, not a fact they scan every visit
            alongside Location or Received, so it earns its own smaller card
            rather than crowding the top of the facts card - but at the
            facts card's own width, not the page's. */}
        <Card>
          <CardBody>
            <SectionHeading>Manufacturer QR payload</SectionHeading>
            {detailError !== null && <ErrorNote>{detailError}</ErrorNote>}
            {detailLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size={14} /> Loading…
              </p>
            ) : detail !== null ? (
              <div className="flex flex-col items-center gap-3 pt-3">
                {qrDataUrl !== null && (
                  <img src={qrDataUrl} alt="Device QR, rendered from the manufacturer payload" width={208} height={208} className="rounded-lg border p-1" />
                )}
                <p className="num w-full break-all rounded-lg bg-muted p-2 text-center text-[11px] text-muted-foreground">
                  {extractQrRaw(detail.deviceQr) ?? 'no payload recorded'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">-</p>
            )}
          </CardBody>
        </Card>
        </div>

        {/* Main: the lifecycle timeline. max-w-2xl so it doesn't stretch to
            fill the grid's full remaining width on a wide viewport - its
            content (a title, one banner, a short vertical list) doesn't need
            anywhere near that much room. */}
        <Card className="max-w-2xl">
          <CardBody>
            <h2 className="pb-2 text-base font-medium">Device lifecycle</h2>
            <p className="mb-4 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>A device only moves forward. Once it is marked damaged, it cannot be reverted.</span>
            </p>
            {timeline !== null && (
              <ol>
                {timeline.stages.map((stage, i) => {
                  const isLast = i === timeline.stages.length - 1 && timeline.terminal === null
                  return (
                    <TimelineEntry
                      key={stage.key}
                      dotClass={
                        stage.state === 'current'
                          ? 'bg-primary ring-4 ring-primary/20'
                          : stage.state === 'reached'
                            ? 'bg-primary/70'
                            : 'bg-muted-foreground/25'
                      }
                      lineHidden={isLast && timeline.terminal === null}
                      muted={stage.state === 'future'}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <p className={cn('text-sm font-medium', stage.state === 'future' && 'text-muted-foreground')}>
                          {STAGE_COPY[stage.key]?.label ?? stage.key}
                          {stage.key === 'ALLOCATED' && stage.state === 'future' && (
                            <span className="ml-2 text-[10.5px] font-normal uppercase tracking-wide text-muted-foreground">
                              not in use yet
                            </span>
                          )}
                        </p>
                        {stage.state === 'current' && (
                          <span className="shrink-0 text-xs text-muted-foreground" title={fmtDateTime(row.updatedAt)}>
                            {fmtRelative(row.updatedAt)}
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] text-muted-foreground">{STAGE_COPY[stage.key]?.sub}</p>
                    </TimelineEntry>
                  )
                })}
                {timeline.terminal !== null && (
                  <TimelineEntry dotClass="bg-red-500 ring-4 ring-red-500/20" lineHidden muted={false}>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-sm font-semibold text-red-700 dark:text-red-400">{TERMINAL[timeline.terminal]}</p>
                      <span className="shrink-0 text-xs text-muted-foreground" title={fmtDateTime(row.updatedAt)}>
                        {fmtRelative(row.updatedAt)}
                      </span>
                    </div>
                    <p className="text-[12px] text-muted-foreground">This device cannot be reverted.</p>
                  </TimelineEntry>
                )}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change status</DialogTitle>
            <DialogDescription>
              {row.deviceSerial ?? row.id} is currently <StatusPill value={row.status} />. Moving forward only - this
              cannot be undone once saved.
            </DialogDescription>
          </DialogHeader>
          {statusError !== null && <ErrorNote>{statusError}</ErrorNote>}
          <div className="space-y-2">
            <label htmlFor="unit-status-select" className="text-sm font-medium">
              New status
            </label>
            <SearchSelect
              id="unit-status-select"
              placeholder="Pick a status…"
              options={legalNextStatuses(row.status).map((s) => ({ value: s, label: STATUS_LABEL[s] ?? s }))}
              value={newStatus}
              onChange={setNewStatus}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void saveStatus()} disabled={newStatus === ''} loading={savingStatus}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BackLink({ fromSearch }: { fromSearch: string }) {
  return (
    <Link
      to={`/inventory${fromSearch !== '' ? `?${fromSearch}` : ''}`}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" /> Inventory
    </Link>
  )
}

function TimelineEntry({
  dotClass,
  lineHidden,
  muted,
  children,
}: {
  dotClass: string
  lineHidden?: boolean
  muted: boolean
  children: ReactNode
}) {
  return (
    <li className={cn('relative flex gap-3 pb-5', muted && 'opacity-70')}>
      <div className="flex flex-col items-center">
        <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', dotClass)} aria-hidden="true" />
        {lineHidden !== true && <span className="mt-1 w-px flex-1 bg-border" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pb-1">{children}</div>
    </li>
  )
}

interface TimelineStage {
  key: string
  state: 'reached' | 'current' | 'future'
}

function buildTimeline(row: UnitInventoryRow): { stages: TimelineStage[]; terminal: string | null } {
  const terminal = row.status in TERMINAL ? row.status : null
  // On the spine, position is exact. On a terminal branch the row's own links
  // prove how far it got: a shipment proves DISPATCHED, a printed-for merchant
  // proves PRINTED; anything further is unknown and stays unreached.
  const currentIdx =
    terminal === null
      ? SPINE.indexOf(row.status as (typeof SPINE)[number])
      : row.shipment !== null
        ? SPINE.indexOf('DISPATCHED')
        : row.printedForMerchant !== null
          ? SPINE.indexOf('PRINTED')
          : SPINE.indexOf('IN_STOCK')
  const stages: TimelineStage[] = SPINE.map((key, i) => ({
    key,
    state: i < currentIdx ? 'reached' : i === currentIdx ? (terminal === null ? 'current' : 'reached') : 'future',
  }))
  return { stages, terminal }
}

// device_qr was stored as { raw: <the sheet cell> } by the ops upload; the
// vendor channel may store other shapes, so anything unrecognized renders as
// its JSON rather than nothing.
function extractQrRaw(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null
  if (typeof payload === 'string') return payload
  if (typeof payload === 'object' && 'raw' in payload && typeof (payload as { raw: unknown }).raw === 'string') {
    return (payload as { raw: string }).raw
  }
  try {
    return JSON.stringify(payload)
  } catch {
    return null
  }
}
