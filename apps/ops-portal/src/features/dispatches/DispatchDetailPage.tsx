import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Boxes,
  Building2,
  Hourglass,
  Inbox,
  Landmark,
  Package,
  PackageCheck,
  Printer,
  QrCode,
  Route,
  Send,
  Smartphone,
  Store,
  Truck,
  Undo2,
  Zap,
} from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  flagDamage,
  getBatchDetail,
  getDamageReasons,
  getDevices,
  getDispatchDetail,
  getPoolEntries,
  markActivated,
  requestActivation,
  type BatchEntryRow,
  type DamageReasonRow,
  type DispatchDetailView,
  type UnitInventoryRow,
} from '../../api/endpoints.js'
import { ApiError } from '../../api/errors.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'
import {
  Button,
  Card,
  CardBody,
  ErrorNote,
  EmptyState,
  Field,
  Input,
  InfoNote,
  Select,
  SkeletonRows,
  StatusPill,
  CodeChip,
} from '../../ui/primitives.js'
import { LifecycleRail, type RailStage } from '../../ui/LifecycleRail.js'
import { BackLink, FactRow, NoValue, SectionHeading } from '../../ui/DetailFacts.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { DispatchGroupBadge } from '../fulfillment/DispatchGroupBadge.js'
import { fmtDateTime, statusMeta } from '../../ui/format.js'

// ONE DISPATCH, END TO END: what was asked for, what it became, and where it has
// reached. This is the page an operator lands on when someone asks about a
// merchant by name.
//
// ACTIVATION IS A CARD, NEVER A RUNG (revised 16 Aug 2026, UAT walkthrough
// findings A3/A4, superseding the 2026-08-15 no-activation-here ruling). That
// ruling's rail half survives in full: the RAIL is the parcel's, a dispatch
// delivers and does not activate, and rendering activation as a rung read as a
// stalled lifecycle on every collateral dispatch, which is exactly the
// confusion D-16 separated the axes to end. Its removal half did not survive:
// the device page never gained the activation ACTIONS the ruling pointed at,
// requestActivation had no consumer anywhere, so REQUEST_SENT_TO_CWD was
// unreachable from the entire UI while D-16/T4.5 records that this page
// carries BOTH axes. So activation is a fact card beside Request and
// Fulfilment: status, instant, trail, and the two writes the Activation
// worklist already uses. A COLLATERAL dispatch states its terminal is
// Delivered instead of offering a write that would 409.
//
// ONE HORIZONTAL RAIL, the same shared LifecycleRail the device page uses:
// the delivery lifecycle is a single unbranched ladder and stays one. The rail
// is the POSITION SUMMARY; the per-event courier trail with its two clocks
// (S22: reported by the courier vs recorded by us), source channels and
// override reasons lives on the shipment page, one click away through the AWB.
//
// WHERE EVERY STAGE'S TIME COMES FROM, and where none exists. The courier legs
// are genuine append-only events, so they carry real instants. Everything
// BEFORE the print vendor is a current-value column with no per-transition row
// anywhere, so those rungs render as reached with NO time rather than borrowing
// one. The single exception is the pool's exit: a batch claims its records
// inside the same transaction that creates the batch, so the batch's own
// instant IS when this dispatch stopped waiting.
//
// STATUS VOCABULARY IS THE BRD'S (section 6.2 Key Status Lifecycle: Received,
// Pending Batch, QR Generated, Sent to Print Vendor, Dispatched by Vendor, In
// Transit, Delivered) plus the courier ladder from FR-06. Nothing on this page
// is a stage somebody invented for the screen.

export function DispatchDetailPage() {
  const { client } = useAuth()
  const { asgnId } = useParams<{ asgnId: string }>()
  const location = useLocation()
  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch ?? ''

  const [detail, setDetail] = useState<DispatchDetailView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // What the analytics read does NOT carry: the ordered quantities and the QR.
  // Both live in fulfillment, keyed by this same Dispatch ID, so they are fetched
  // from the reads that already serve them rather than asked of a new route.
  const [entry, setEntry] = useState<BatchEntryRow | null>(null)
  const [batchFormedAt, setBatchFormedAt] = useState<string | null>(null)
  const [labelQr, setLabelQr] = useState<string | null>(null)
  const [deviceIdBySerial, setDeviceIdBySerial] = useState<ReadonlyMap<string, string>>(new Map())

  const load = useCallback(async () => {
    if (asgnId === undefined) return
    setLoading(true)
    setError(null)
    try {
      setDetail(await getDispatchDetail(client, asgnId))
    } catch {
      // "Not found" and "the read failed" are not told apart here, so the message
      // covers both honestly rather than claiming the dispatch does not exist.
      setError('Could not read this dispatch. It may not have been projected yet.')
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [client, asgnId])

  useEffect(() => {
    void load()
  }, [load])

  // Enrichment, and deliberately silent on failure: this page must still render
  // everything the analytics read gave it if fulfillment is unreachable. A
  // missing quantity is a missing line, never a broken page.
  useEffect(() => {
    if (detail === null || asgnId === undefined) return
    let cancelled = false

    if (detail.batchId !== null) {
      getBatchDetail(client, detail.batchId)
        .then((batch) => {
          if (cancelled || batch === null) return
          setEntry(batch.entries.find((e) => e.asgnId === asgnId) ?? null)
          setBatchFormedAt(batch.batch.createdAt)
          const artifact = batch.artifacts.find((a) => a.asgnId === asgnId && a.supersededAt === null)
          setLabelQr(artifact?.labelQr ?? null)
        })
        .catch(() => {})
    } else {
      // Not batched yet, so the pool still holds the row.
      getPoolEntries(client)
        .then((pool) => {
          if (cancelled || !Array.isArray(pool)) return
          setEntry(pool.find((p) => p.asgnId === asgnId) ?? null)
        })
        .catch(() => {})
    }

    // The analytics read names devices by their HARDWARE SERIAL; the device page
    // is keyed by unit id. Resolving through the inventory list is what makes
    // each serial a link instead of a dead string.
    if (detail.deviceIds.length > 0) {
      getDevices(client)
        .then((devices: UnitInventoryRow[]) => {
          if (cancelled || !Array.isArray(devices)) return
          setDeviceIdBySerial(
            new Map(devices.filter((d) => d.deviceSerial !== null).map((d) => [d.deviceSerial as string, d.id])),
          )
        })
        .catch(() => {})
    }

    return () => {
      cancelled = true
    }
  }, [client, detail, asgnId])

  /** The UPI ID, out of the QR's own pa= parameter, so there is no second source. */
  const vpa = useMemo(() => {
    if (labelQr === null) return null
    const q = labelQr.indexOf('?')
    if (q < 0) return null
    for (const pair of labelQr.slice(q + 1).split('&')) {
      const [k, v] = pair.split('=')
      if (k === 'pa' && v !== undefined) return decodeURIComponent(v)
    }
    return null
  }, [labelQr])

  const rail = useMemo(
    () => (detail === null ? [] : buildRail(detail, entry, batchFormedAt)),
    [detail, entry, batchFormedAt],
  )

  // D-16: the activation BRANCH, independent of delivery. The two writes are
  // the same ones the Activation worklist uses; this page offers them beside
  // the dispatch's own facts so an operator on a dispatch never has to walk
  // back to the worklist to act on what they are looking at.
  const [activationAction, setActivationAction] = useState<'request' | 'mark' | null>(null)
  const [activationBusy, setActivationBusy] = useState(false)
  const [activationError, setActivationError] = useState<string | null>(null)

  const runActivationAction = useCallback(async (): Promise<void> => {
    if (asgnId === undefined || activationAction === null) return
    setActivationBusy(true)
    setActivationError(null)
    try {
      if (activationAction === 'request') await requestActivation(client, [asgnId], newIdempotencyKey())
      else await markActivated(client, asgnId, newIdempotencyKey())
      setActivationAction(null)
      await load()
    } catch (e) {
      setActivationError(e instanceof Error ? e.message : 'The write failed.')
    } finally {
      setActivationBusy(false)
    }
  }, [asgnId, activationAction, client, load])

  // D-26: damage is flagged HERE, on the dispatch it happened to, now that
  // the damage-file upload is gone (D-25). The operator names the reason from
  // the master (code stored, label shown, DP-5), writes the why into remarks,
  // and, for a COLLATERAL leg only, the counts the replacement should carry
  // (DP-2). A SOUNDBOX leg carries no count: the quantity is fixed at one
  // replacement soundbox (D-27).
  const isCollateral = detail?.dispatchGroup === 'COLLATERAL'
  const [flagOpen, setFlagOpen] = useState(false)
  const [reasons, setReasons] = useState<DamageReasonRow[] | null>(null)
  const [reasonCode, setReasonCode] = useState('')
  const [remarks, setRemarks] = useState('')
  const [standeeCount, setStandeeCount] = useState('0')
  const [stickerCount, setStickerCount] = useState('0')
  const [flagBusy, setFlagBusy] = useState(false)
  const [flagError, setFlagError] = useState<string | null>(null)
  const [flagged, setFlagged] = useState<{ childAsgnId: string } | null>(null)

  // The master is read when the dialog first opens, not on page mount: most
  // visits to this page never flag anything.
  useEffect(() => {
    if (!flagOpen || reasons !== null) return
    let cancelled = false
    getDamageReasons(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setReasons(rows)
      })
      .catch(() => {
        if (!cancelled) setFlagError('Could not read the damage reasons. Close and try again.')
      })
    return () => {
      cancelled = true
    }
  }, [flagOpen, reasons, client])

  const trimmedRemarks = remarks.trim()
  const standee = parseCount(standeeCount)
  const sticker = parseCount(stickerCount)
  const countsValid = !isCollateral || (standee !== null && sticker !== null && standee + sticker >= 1)
  const flagValid = reasonCode !== '' && trimmedRemarks !== '' && trimmedRemarks.length <= 500 && countsValid

  const runFlagDamage = useCallback(async (): Promise<void> => {
    if (asgnId === undefined || !flagValid) return
    setFlagBusy(true)
    setFlagError(null)
    try {
      const res = await flagDamage(
        client,
        asgnId,
        {
          reasonCode,
          remarks: trimmedRemarks,
          // Counts ride ONLY on a collateral leg; the server rejects any count
          // on a soundbox leg, so none is ever sent for one.
          ...(isCollateral ? { standeeCount: standee ?? 0, stickerCount: sticker ?? 0 } : {}),
        },
        newIdempotencyKey(),
      )
      setFlagged({ childAsgnId: res.childAsgnId })
      setFlagOpen(false)
      await load()
    } catch (e) {
      // DP-3: one live case per dispatch. The 409 is that rule answering, so
      // it gets its own sentence rather than the generic conflict wording.
      if (e instanceof ApiError && e.status === 409) {
        setFlagError('A live damage case already exists for this dispatch. It has to close before a new one can be raised.')
      } else {
        setFlagError(e instanceof Error ? e.message : 'The write failed.')
      }
    } finally {
      setFlagBusy(false)
    }
  }, [asgnId, flagValid, client, reasonCode, trimmedRemarks, isCollateral, standee, sticker, load])

  if (loading) return <SkeletonRows rows={6} />
  if (error !== null) return <ErrorNote>{error}</ErrorNote>
  if (detail === null) return <EmptyState title="No such dispatch" />

  const ordered =
    entry === null
      ? null
      : [entry.soundbox ? 'Soundbox' : null, entry.standeeCount > 0 ? `${entry.standeeCount} standee` : null, entry.stickerCount > 0 ? `${entry.stickerCount} sticker` : null]
          .filter((p): p is string => p !== null)
          .join(', ')

  // detail.activationStatus is the ANALYTICS fold, and analytics never learns
  // REQUEST_SENT_TO_CWD: no activation-request fact exists (a new topic is a
  // corpus decision, PLAN.md section 7 item 8), so the ops surfaces read that
  // state from TMS. The trail below IS the TMS read, so the latest trail entry
  // wins over a null fold. This is the same read-your-own-write posture the
  // Activation worklist took (V-4), for the same reason.
  const activationStatus = detail.activationStatus ?? detail.activationTrail.at(-1)?.status ?? null

  return (
    <div className="space-y-4">
      <BackLink to="/dispatches" label="Dispatches" fromSearch={fromSearch} />

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{detail.merchantDisplay}</h1>
            <DispatchGroupBadge group={detail.dispatchGroup} />
          </div>
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <CodeChip>{detail.dispatchId}</CodeChip>
            {detail.dispatchGroup === null && <span>legacy combined dispatch</span>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <StatusPill value={detail.courierStatus ?? ''} />
          <WatermarkBadge watermark={detail.watermark.asOf} />
        </div>
      </div>

      {/* The lifecycle owns the top of the page as a horizontal rail, the same
          grammar as the device page. */}
      <Card>
        <CardBody>
          <div className="pb-5">
            <h2 className="text-base font-medium">Dispatch lifecycle</h2>
            <p className="text-[12.5px] text-muted-foreground">
              The BRD delivery ladder, Received through Delivered. The AWB below opens the full courier trail.
            </p>
          </div>
          <LifecycleRail stages={rail} />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardBody>
            {/* WHO ASKED FOR THIS. A soundbox request arrives from a bank on an
                uploaded file, so the requester is the bank and its branch, not a
                person: there is no operator behind a demand row. */}
            <SectionHeading>Request</SectionHeading>
            <FactRow icon={Landmark} label="Requested by">
              {detail.bankDisplay} <span className="text-muted-foreground">({detail.bankCode})</span>
            </FactRow>
            <FactRow icon={Building2} label="Branch">
              {entry?.branchCode ?? <NoValue>not recorded</NoValue>}
            </FactRow>
            <FactRow icon={Store} label="Merchant">
              {detail.merchantDisplay}
            </FactRow>
            <FactRow icon={Boxes} label="Ordered">
              {ordered === null ? <NoValue>not read yet</NoValue> : ordered === '' ? <NoValue>nothing</NoValue> : ordered}
            </FactRow>
            <FactRow icon={QrCode} label="UPI ID">
              {vpa ?? <NoValue>no card composed yet</NoValue>}
            </FactRow>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <SectionHeading>Fulfilment</SectionHeading>
            <FactRow icon={Package} label="Batch">
              {detail.batchId === null ? (
                <NoValue>not batched</NoValue>
              ) : (
                <Link className="underline underline-offset-2" to={`/batches/${detail.batchId}`}>
                  <CodeChip>{detail.batchId}</CodeChip>
                </Link>
              )}
            </FactRow>
            <FactRow icon={Truck} label="AWB">
              {detail.awb === null ? (
                <NoValue>not dispatched</NoValue>
              ) : detail.shptId === null ? (
                <span className="num">{detail.awb}</span>
              ) : (
                <Link className="num underline underline-offset-2" to={`/dispatches/shipment/${detail.shptId}`}>
                  {detail.awb}
                </Link>
              )}
            </FactRow>
            <FactRow icon={Smartphone} label="Devices">
              {detail.deviceIds.length === 0 ? (
                <NoValue>none paired</NoValue>
              ) : (
                <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
                  {detail.deviceIds.map((serial) => {
                    const unitId = deviceIdBySerial.get(serial)
                    return unitId === undefined ? (
                      // A serial we cannot resolve renders as text: a dead link
                      // is worse than an honest string.
                      <span key={serial} className="num">
                        {serial}
                      </span>
                    ) : (
                      <Link key={serial} className="num underline underline-offset-2" to={`/inventory/device/${unitId}`}>
                        {serial}
                      </Link>
                    )
                  })}
                </span>
              )}
            </FactRow>
            <FactRow icon={Truck} label="Dispatched">
              {detail.dispatchDate === null ? <NoValue>not yet</NoValue> : fmtDateTime(detail.dispatchDate)}
            </FactRow>
            <FactRow icon={PackageCheck} label="Delivered">
              {detail.deliveryDate === null ? <NoValue>not yet</NoValue> : fmtDateTime(detail.deliveryDate)}
            </FactRow>
          </CardBody>
        </Card>

        {/* D-16: the SECOND axis. A soundbox's activation is independent of its
            delivery; a COLLATERAL consignment has no activation at all and its
            lifecycle ends at Delivered, which this card says instead of
            offering a write that would 409. */}
        <Card>
          <CardBody>
            <SectionHeading>Activation</SectionHeading>
            {detail.dispatchGroup === 'COLLATERAL' ? (
              <p className="text-sm text-muted-foreground">
                Not applicable: a collateral consignment ends at Delivered. Activation belongs to the soundbox dispatch.
              </p>
            ) : (
              <>
                <FactRow icon={Zap} label="Status">
                  {activationStatus === null ? (
                    <NoValue>no request sent yet</NoValue>
                  ) : (
                    <StatusPill value={activationStatus} />
                  )}
                </FactRow>
                <FactRow icon={PackageCheck} label="Activated">
                  {detail.activationDate === null ? <NoValue>not yet</NoValue> : fmtDateTime(detail.activationDate)}
                </FactRow>
                {detail.activationTrail.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {detail.activationTrail.map((e, i) => (
                      <p key={i} className="text-[12.5px] text-muted-foreground">
                        <StatusPill value={e.status} /> <span className="num">{fmtDateTime(e.occurredAt)}</span>
                        <span className="ml-1">via {e.statusSource}</span>
                      </p>
                    ))}
                  </div>
                )}
                {activationError !== null && <ErrorNote>{activationError}</ErrorNote>}
                {activationStatus !== 'ACTIVATED' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {activationStatus === null && (
                      <Button variant="secondary" onClick={() => setActivationAction('request')}>
                        <Send className="mr-1.5 h-3.5 w-3.5" /> Record request sent to CWD
                      </Button>
                    )}
                    <Button onClick={() => setActivationAction('mark')}>
                      <Zap className="mr-1.5 h-3.5 w-3.5" /> Mark activated
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>

        {/* D-26: the damage flag lives on the dispatch it happened to. Legacy
            combined rows (null group) predate the leg split the flag's count
            rules key on (DP-2), so they get no flag control rather than a
            write the server holds no rule for. */}
        {detail.dispatchGroup !== null && (
          <Card>
            <CardBody>
              <SectionHeading>Damage</SectionHeading>
              {flagged !== null ? (
                <InfoNote>
                  Damage case opened. The replacement dispatch is{' '}
                  <Link className="underline underline-offset-2" to={`/dispatches/${flagged.childAsgnId}`}>
                    <CodeChip>{flagged.childAsgnId}</CodeChip>
                  </Link>
                  , non-billable, already in the normal pool.
                </InfoNote>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Flagging opens a damage case and raises a non-billable replacement into the normal pool. One live
                    case per dispatch; a new flag is allowed once the case closes.
                  </p>
                  <div className="mt-3">
                    <Button variant="secondary" onClick={() => setFlagOpen(true)}>
                      <AlertTriangle className="mr-1.5 h-3.5 w-3.5" /> Flag damage
                    </Button>
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={activationAction !== null}
        onOpenChange={(open) => {
          if (!open) setActivationAction(null)
        }}
        title={activationAction === 'request' ? 'Record that the activation request went to the CWD?' : `Mark ${detail.merchantDisplay} activated?`}
        description={
          activationAction === 'request'
            ? 'Records that the activation sheet for this dispatch was sent to the CWD. The audit carries this as your action.'
            : 'Records that the CWD confirmed this device and its SIM. This cannot be undone from here.'
        }
        confirmLabel={activationAction === 'request' ? 'Record request' : 'Mark activated'}
        busy={activationBusy}
        onConfirm={() => {
          void runActivationAction()
        }}
      />

      <ConfirmDialog
        open={flagOpen}
        onOpenChange={(open) => {
          setFlagOpen(open)
          if (!open) setFlagError(null)
        }}
        title={`Flag ${detail.merchantDisplay}'s dispatch as damaged?`}
        description="Opens a damage case and raises a non-billable replacement into the normal pool."
        // NOT "Flag damage": the card's opener already carries that name, and
        // two buttons with one accessible name is an ambiguity for both a
        // screen reader and a test. The confirm names the consequence.
        confirmLabel="Open damage case"
        busy={flagBusy}
        confirmDisabled={!flagValid}
        error={flagError}
        onConfirm={() => {
          void runFlagDamage()
        }}
      >
        <div className="space-y-4">
          <Field label="Reason" htmlFor="flag-damage-reason" hint="From the damage-reason master. The code is what is stored.">
            <Select
              id="flag-damage-reason"
              aria-label="Reason"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              disabled={flagBusy}
            >
              <option value="">Select a reason</option>
              {(reasons ?? [])
                .filter((r) => r.active)
                .map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
            </Select>
          </Field>
          <Field
            label="Remarks"
            htmlFor="flag-damage-remarks"
            hint={`Required. ${Math.max(0, 500 - remarks.length)} characters left.`}
          >
            <textarea
              id="flag-damage-remarks"
              aria-label="Remarks"
              maxLength={500}
              rows={3}
              className="w-full rounded-lg border border-border bg-input/50 px-3 py-2 text-sm outline-none focus-visible:border-ring"
              placeholder="What happened, in your own words."
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              disabled={flagBusy}
            />
          </Field>
          {isCollateral ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Standees" htmlFor="flag-damage-standee">
                  <Input
                    id="flag-damage-standee"
                    aria-label="Standees"
                    type="number"
                    min={0}
                    max={99}
                    value={standeeCount}
                    onChange={(e) => setStandeeCount(e.target.value)}
                    disabled={flagBusy}
                  />
                </Field>
                <Field label="Stickers" htmlFor="flag-damage-sticker">
                  <Input
                    id="flag-damage-sticker"
                    aria-label="Stickers"
                    type="number"
                    min={0}
                    max={99}
                    value={stickerCount}
                    onChange={(e) => setStickerCount(e.target.value)}
                    disabled={flagBusy}
                  />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                Whole numbers 0 to 99, at least one item in total: the collateral the replacement should carry.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              One replacement soundbox is raised, fixed per D-27. There is no quantity to enter.
            </p>
          )}
        </div>
      </ConfirmDialog>
    </div>
  )
}

/** An int 0 to 99 or null: the D-27 count grammar, checked before submit. */
function parseCount(raw: string): number | null {
  return /^\d{1,2}$/.test(raw.trim()) ? Number(raw.trim()) : null
}

/** The BRD 6.2 ladder, as rail rungs. Order IS the lifecycle. */
const RAIL_LADDER = [
  { key: 'RECEIVED', label: 'Received', icon: Inbox },
  { key: 'PENDING_BATCH', label: 'Pending batch', icon: Hourglass },
  { key: 'QR_GENERATED', label: 'QR generated', icon: QrCode },
  { key: 'SENT_TO_VENDOR', label: 'Sent to print vendor', icon: Printer },
  { key: 'DISPATCHED_BY_VENDOR', label: 'Dispatched by vendor', icon: Truck },
  { key: 'IN_TRANSIT', label: 'In transit', icon: Route },
  { key: 'DELIVERED', label: 'Delivered', icon: PackageCheck },
] as const

/** Where a courier status sits on the ladder above. */
const COURIER_RUNG: Record<string, number> = {
  DISPATCHED_BY_VENDOR: 4,
  IN_TRANSIT: 5,
  DELIVERED: 6,
}

/**
 * The BRD's ladder with the row's real position on it.
 *
 * The first four rungs are inferred from where the row SITS, because nothing
 * records their transitions: a dispatch that exists was received; one with no
 * batch is still pending a batch; a composed card proves QR generation; a
 * dispatch_state past QR_GENERATED proves the vendor has it. Inferred rungs
 * carry no instant (the pool-exit exception is noted at the top of this file).
 * Courier rungs are dated from the trail's own append-only events, latest
 * event per rung, since a rung can be scanned twice.
 *
 * RETURNED is terminal (the parcel came back) and closes the rail in red.
 * FAILED is NOT terminal in the domain - a failed attempt can be re-attempted
 * and still deliver - so it renders as a red stop while Delivered stays ahead
 * of it as a future rung.
 */
function buildRail(detail: DispatchDetailView, entry: BatchEntryRow | null, batchFormedAt: string | null): RailStage[] {
  const batched = detail.batchId !== null
  const dispatchState = entry?.dispatchState ?? null
  const composed = dispatchState !== null
  const sentToVendor = dispatchState === 'SENT_TO_VENDOR' || dispatchState === 'DISPATCHED_BY_VENDOR'
  const trail = detail.deliveryTrail
  const last = trail.at(-1) ?? null
  const offLadder = last !== null && !(last.status in COURIER_RUNG)

  // The furthest rung the trail proves, which for a FAILED/RETURNED parcel is
  // the furthest ORDINARY rung any of its events reached.
  const provenByTrail = trail.reduce((max, e) => Math.max(max, COURIER_RUNG[e.status] ?? 4), -1)

  const currentIdx =
    trail.length > 0 ? provenByTrail : sentToVendor ? 4 : composed ? 3 : batched ? 2 : 1

  /** The latest real instant the courier reported for one specific rung. */
  const rungTime = (key: string): string | null =>
    trail.reduce<string | null>((latest, e) => (e.status === key ? e.courierTimestamp : latest), null)

  const stages: RailStage[] = RAIL_LADDER.map((rung, i) => ({
    key: rung.key,
    label: rung.label,
    icon: rung.icon,
    // With an off-ladder stop (failed, returned) appended, the spine holds no
    // 'current': the red stop is where the parcel actually is.
    state: i < currentIdx ? 'reached' : i === currentIdx ? (offLadder ? 'reached' : 'current') : 'future',
    at:
      rung.key === 'PENDING_BATCH' && batched
        ? batchFormedAt
        : i <= currentIdx
          ? rungTime(rung.key)
          : null,
  }))

  if (offLadder) {
    stages.push({
      key: last.status,
      label: last.status === 'RETURNED' ? 'Returned to origin' : statusMeta(last.status).label,
      icon: last.status === 'RETURNED' ? Undo2 : AlertTriangle,
      state: 'current',
      at: last.courierTimestamp,
      terminal: true,
    })
  }
  return stages
}
