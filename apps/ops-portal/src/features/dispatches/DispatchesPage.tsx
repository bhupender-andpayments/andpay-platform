import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, CheckCircle2, PackageX, Repeat, Send, Truck, Upload, Warehouse } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { SearchSelect } from '../../components/Picker.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import {
  getBankMasters,
  getReport,
  type BankMasterRow,
  type ReportFilters,
  type ReportRow,
  type Watermark,
} from '../../api/endpoints.js'
import {
  PageHeader,
  Card,
  CardHeader,
  Field,
  Input,
  Button,
  Toolbar,
  ErrorNote,
  StatusPill,
  CodeChip,
} from '../../ui/primitives.js'
import { fmtDateTime, statusMeta } from '../../ui/format.js'
import { PIPELINE_STAGES, STAGE_FILTER_CANCELLED, STAGE_FILTER_DAMAGED, STAGE_FILTER_HELD } from './dispatchStatus.js'
import { COURIER_STATUSES } from '../dashboards/courierStatuses.js'
import { DispatchGroupBadge } from '../fulfillment/DispatchGroupBadge.js'

// THE DISPATCH LIST, rebuilt on the shape the Inventory pages set: a summary row
// that doubles as the filter, a flat toolbar of filters ABOVE the grid, and rows
// that open the thing they name.
//
// WHAT WAS WRONG WITH IT, because it is the whole argument. The filters sat
// inside the card, under the title, so the page opened with its controls half
// hidden. The grid built its columns from whatever keys the report happened to
// return, so a raw `programId` uuid was on screen at all times taking up a
// column an operator can do nothing with. And nothing was clickable: the rows
// carried the exact Dispatch ID that `/dispatches/:asgnId` wants, and a
// perfectly good detail page sat unreachable behind it.
//
// TWO LISTS, AND WHY BOTH BELONG. The upper grid is one row per DISPATCH (the
// demand side: what a merchant asked for, what it became). The lower one is one
// row per AWB (the carrier side). They are not the same list at a different
// grain: one Dispatch ID can travel under TWO AWBs, the soundbox kit under one
// and the standee under another, so neither can stand in for the other. Each
// row of each list now opens its own page.
//
// NO PER-ROW WRITE ACTIONS. Correct status and Override used to sit on every
// row here and injected their full forms mid-page when clicked, pushing the
// grid away from under the operator's cursor. They act on a SHIPMENT, so they
// now live on the shipment detail page (open the AWB), as dialogs. A list row
// navigates; it does not mutate.

/** The report keys this page reads, typed at the edge of the untyped ReportRow. */
function str(row: ReportRow, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function dispatchIdOf(row: ReportRow): string | null {
  return str(row, 'dispatchId')
}

// The four states a dispatch can be in on the carrier axis, from the report's
// own `courierStatus`. Named here only to group the courier ladder into
// something a tile can count; every value is the courier vocabulary itself
// (COURIER_STATUSES), never a state invented for this screen.
const IN_FLIGHT = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] as const
const OFF_LADDER = ['FAILED', 'RETURNED'] as const

// THE LIFECYCLE AXIS, which this page could not show until 18 Aug 2026
// (decision D12): the read it used carried no pipeline_state and admitted only
// already-dispatched rows, so a dispatch was invisible until a courier had it.
//
// THE STAGE AXIS comes from dispatchStatus.ts now, and the LABELS come from
// statusMeta, the same source the Stage column's pill uses.
//
// This page used to keep its own LIFECYCLE_LABELS map, which is how the filter
// dropdown came to say "Pending batch" and "At print vendor" while the table
// column beside it said "Received" and "Sent to print vendor" for the very same
// value (found 23 Aug 2026). One value, one name, one place.
const LIFECYCLE_ORDER = PIPELINE_STAGES

function lifecycleOf(row: ReportRow): string {
  return str(row, 'pipelineState') ?? 'RECEIVED'
}

/** Whether this dispatch is parked out of the pool. See STAGE_FILTER_HELD. */
function isHeld(row: ReportRow): boolean {
  return str(row, 'poolStatus') === 'HELD'
}

/** A withdrawn replacement: it left the pool CANCELLED and goes nowhere. */
function isCancelled(row: ReportRow): boolean {
  return str(row, 'poolStatus') === 'CANCELLED'
}

/**
 * Whether damage was raised AGAINST this dispatch, i.e. a replacement was minted
 * to take its place. See STAGE_FILTER_DAMAGED: this is the PARENT's marker, the
 * one no list carried before; the child reads as a replacement already.
 */
function isDamaged(row: ReportRow): boolean {
  return str(row, 'replacementStatus') !== null
}

/** Soundbox or collateral, the delivery group this leg belongs to. */
function groupOf(row: ReportRow): string | null {
  return str(row, 'dispatchGroup')
}

/** The SIMs the edge merged in from fulfillment, positional against deviceIds. */
function simsOf(row: ReportRow): string[] {
  const value = row['simNos']
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v !== '')
}

function devicesOf(row: ReportRow): string[] {
  const value = row['deviceIds']
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v !== '')
}

export function DispatchesPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [rows, setRows] = useState<ReportRow[]>([])
  const [watermark, setWatermark] = useState<Watermark | null>(null)
  const [banks, setBanks] = useState<readonly BankMasterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Every filter lives in the URL, so a filtered list can be linked, reloaded
  // and returned to from a detail page. Same idiom as Inventory: an empty value
  // deletes its key, and writes replace rather than push so typing in the search
  // box does not build a history entry per keystroke.
  const q = searchParams.get('q') ?? ''
  const bank = searchParams.get('bank') ?? ''
  // Its own axis rather than a spelling of `q`. An operator arrives holding a
  // batch id from the batches list and wants THAT batch's legs, then narrows by
  // stage or date within it. Folded into the free-text box those two intents
  // fight: typing a batch id there also matches merchants and AWBs, and cannot
  // be combined with a different text search at the same time.
  const batch = searchParams.get('batch') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  const statusSel = useMemo(() => searchParams.get('status')?.split(',').filter(Boolean) ?? [], [searchParams])

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value === '') next.delete(key)
          else next.set(key, value)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  /** Several params at once, so two mutually exclusive axes settle in one write. */
  const setParams = useCallback(
    (patch: Record<string, string>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            if (value === '') next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // ?held=1 IS STILL HONOURED, folded into the stage selection rather than kept
  // as its own axis. The toggle that wrote it is gone (Held is a stage option
  // now), but links an operator already shared read "the held ones" and should
  // keep meaning that, so the old param is translated instead of dropped.
  const stageSel = useMemo(() => {
    const picked = searchParams.get('stage')?.split(',').filter(Boolean) ?? []
    const legacyHeld = searchParams.get('held') === '1'
    return legacyHeld && !picked.includes(STAGE_FILTER_HELD) ? [...picked, STAGE_FILTER_HELD] : picked
  }, [searchParams])
  // ?view=shipments WAS the carrier tab on this page and is now its own section.
  // Links to it are in circulation, so it redirects rather than silently showing
  // the dispatch grid, which would look like the tab had been deleted.
  const legacyShipmentsView = searchParams.get('view') === 'shipments'
  const groupSel = searchParams.get('group') ?? ''
  // BILLABLE (23 Aug 2026, ops-team ask). Its own axis, not a Category value:
  // a dispatch is soundbox-or-collateral AND billable-or-not, and folding the
  // second into the first dropdown would make the two mutually exclusive when
  // they are independent. 'yes' | 'no' | '' (either).
  const billableSel = searchParams.get('billable') ?? ''

  const anyFilter =
    q !== '' ||
    bank !== '' ||
    batch !== '' ||
    from !== '' ||
    to !== '' ||
    statusSel.length > 0 ||
    stageSel.length > 0 ||
    groupSel !== '' ||
    billableSel !== ''

  // The date window and the bank go to the SERVER, because they narrow the heavy
  // read. Status and text are applied here, because the tiles are the status
  // breakdown of what the server returned and would otherwise count only the
  // slice already filtered out.
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    const filters: ReportFilters = {}
    if (from !== '') filters.from = from
    if (to !== '') filters.to = to
    if (bank !== '') filters.bank = bank
    try {
      const result = await getReport(client, 'dispatches', filters)
      setRows(Array.isArray(result.rows) ? result.rows : [])
      setWatermark(result.watermark)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load dispatches.')
    } finally {
      setLoading(false)
    }
  }, [client, from, to, bank])

  useEffect(() => {
    void load()
  }, [load])

  // Loaded separately and silently: a bank list that does not arrive costs the
  // filter its names, not the page its rows.
  useEffect(() => {
    let cancelled = false
    getBankMasters(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setBanks(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const bankName = useCallback(
    (code: string | null): string => {
      if (code === null) return '-'
      return banks.find((b) => b.bankReferenceCode === code)?.displayName ?? code
    },
    [banks],
  )

  // Stage 1: text search, which the tiles count within. Searching for a merchant
  // and then reading the tiles should describe THAT merchant's dispatches.
  const searched = useMemo(() => {
    const byGroup = groupSel === '' ? rows : rows.filter((r) => groupOf(r) === groupSel)
    // Billable narrows alongside category, before the tiles, so the tiles read
    // as "this slice's breakdown" exactly as they already do for batch and
    // category. THE FIELD IS `billable`, not `billableFlag`: each report names
    // its own columns and the dispatches projector (mediation.ts dispatchesRow)
    // says `billable`, while `billableFlag` belongs to other reports. Reading
    // the wrong name made this filter keep everything on "Billable" and empty
    // the grid on "Not billable" (the 23 Aug defect). A row whose flag the
    // report omitted is treated as billable, which is what an ordinary
    // bank-raised dispatch is.
    const byBillable =
      billableSel === ''
        ? byGroup
        : byGroup.filter((r) => (r['billable'] !== false) === (billableSel === 'yes'))
    // Batch narrows BEFORE the text search and before the tiles, so the tiles
    // read as "this batch's status breakdown" rather than the whole report's.
    // Substring and case-insensitive, because the id is long enough that a
    // partial paste is the normal case.
    const byBatch =
      batch === ''
        ? byBillable
        : byBillable.filter((r) => (str(r, 'batchId') ?? '').toLowerCase().includes(batch.trim().toLowerCase()))
    if (q === '') return byBatch
    const needle = q.toLowerCase()
    // Batch id and device serial joined the searchable fields with the D12 read,
    // because both are things an operator arrives holding: a batch id from the
    // batches list, a serial off the device itself.
    return byBatch.filter((r) =>
      [
        dispatchIdOf(r),
        str(r, 'merchantDisplay'),
        str(r, 'awb'),
        str(r, 'batchId'),
        ...devicesOf(r),
        ...simsOf(r),
      ].some((v) => v !== null && v !== undefined && v.toLowerCase().includes(needle)),
    )
  }, [rows, q, groupSel, batch, billableSel])

  // Stage 2: + status. These are the grid's rows; the tiles deliberately read
  // from `searched` so picking one status does not zero the other five.
  const tableRows = useMemo(
    () =>
      searched
        .filter((r) => statusSel.length === 0 || statusSel.includes(str(r, 'courierStatus') ?? ''))
        // HELD RIDES THE STAGE FILTER (23 Aug 2026), replacing a separate Hold
        // toggle. It is still not a pipeline stage and is still stored on a
        // different table; what changed is that an operator should not have to
        // learn that to find a held parcel. Selecting Held matches on the pool
        // axis; selecting any real stage matches on the pipeline axis;
        // pick both and a row matching either is kept, which is how MultiSelect
        // already behaves for every other option.
        .filter((r) => {
          if (stageSel.length === 0) return true
          if (stageSel.includes(STAGE_FILTER_HELD) && isHeld(r)) return true
          if (stageSel.includes(STAGE_FILTER_DAMAGED) && isDamaged(r)) return true
          if (stageSel.includes(STAGE_FILTER_CANCELLED) && isCancelled(r)) return true
          return stageSel
            .filter((k) => k !== STAGE_FILTER_HELD && k !== STAGE_FILTER_DAMAGED && k !== STAGE_FILTER_CANCELLED)
            .includes(lifecycleOf(r))
        }),
    [searched, statusSel, stageSel],
  )

  const heldCount = useMemo(() => searched.filter(isHeld).length, [searched])
  const damagedCount = useMemo(() => searched.filter(isDamaged).length, [searched])
  const cancelledCount = useMemo(() => searched.filter(isCancelled).length, [searched])

  const countOf = useCallback(
    (statuses: readonly string[]) => searched.filter((r) => statuses.includes(str(r, 'courierStatus') ?? '')).length,
    [searched],
  )

  const tiles: StatTileDef[] = [
    {
      key: 'all',
      label: 'Dispatches',
      hint: 'in the current window',
      icon: Boxes,
      tone: 'text-primary',
      chip: 'bg-primary/10',
      value: searched.length,
    },
    {
      // WAS "Awaiting vendor", counting rows with no AWB, which the old read
      // could never contain: its predicate admitted only already-dispatched
      // rows, so this tile was structurally always zero. It now counts the two
      // pre-vendor lifecycle stages, which is what an operator meant by it.
      key: 'pending',
      label: 'Before the vendor',
      hint: 'pending batch or batched',
      icon: Warehouse,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      // NOT the cancelled ones (24 Aug 2026): this tile means "waiting to go to
      // the vendor", and a withdrawn replacement is waiting for nothing. It is
      // the only stage tile a cancelled row can reach, since a case can only be
      // withdrawn before its replacement is batched.
      value: searched.filter((r) => !isCancelled(r) && ['RECEIVED', 'BATCHED'].includes(lifecycleOf(r))).length,
    },
    {
      key: 'atVendor',
      label: 'At print vendor',
      hint: 'sent, not yet shipped',
      icon: Send,
      tone: 'text-violet-600',
      chip: 'bg-violet-500/10',
      value: searched.filter((r) => lifecycleOf(r) === 'SENT_TO_VENDOR').length,
    },
    {
      key: 'dispatched',
      label: 'Dispatched',
      hint: 'handed to the courier',
      icon: Send,
      tone: 'text-sky-600',
      chip: 'bg-sky-500/10',
      value: countOf(['DISPATCHED_BY_VENDOR']),
    },
    {
      key: 'transit',
      label: 'In transit',
      hint: 'picked up, on its way',
      icon: Truck,
      tone: 'text-indigo-600',
      chip: 'bg-indigo-500/10',
      value: countOf(IN_FLIGHT),
    },
    {
      key: 'delivered',
      label: 'Delivered',
      hint: 'courier confirmed delivery',
      icon: CheckCircle2,
      tone: 'text-emerald-600',
      chip: 'bg-emerald-500/10',
      value: countOf(['DELIVERED']),
    },
    {
      // REPLACEMENTS (23 Aug 2026, ops-team ask): damage-driven dispatches, the
      // number the business watches. It filters the BILLABLE axis rather than
      // inventing a third: every replacement is minted non-billable, so
      // "not billable" and "replacement" are the same set on this report, and
      // one param is better than two that can contradict each other.
      key: 'replacements',
      label: 'Replacements',
      hint: 'raised from damage, not billable',
      icon: Repeat,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: searched.filter((r) => typeof r['replacementOfAsgnId'] === 'string').length,
    },
    {
      // DAMAGED (24 Aug 2026): the dispatches damage was raised AGAINST, which
      // is the question an operator chasing a case asks and no list could
      // answer. Filters the STAGE axis, where the overlay lives, so the tile
      // and the Stage dropdown are the same control by two routes.
      key: 'damaged',
      label: 'Damaged',
      hint: 'a replacement was raised for these',
      icon: PackageX,
      tone: 'text-rose-600',
      chip: 'bg-rose-500/10',
      value: damagedCount,
    },
    {
      key: 'exception',
      label: 'Failed or returned',
      hint: 'a failed attempt can still move on',
      icon: PackageX,
      tone: 'text-red-600',
      chip: 'bg-red-500/10',
      value: countOf(OFF_LADDER),
    },
  ]

  // Which COURIER statuses a tile stands for. 'all' clears everything; the two
  // pre-vendor tiles are lifecycle stages rather than courier states, so they
  // filter through their own `stage` param and appear here as empty.
  const STATUSES_FOR: Record<string, readonly string[]> = {
    all: [],
    pending: [],
    replacements: [],
    damaged: [],
    atVendor: [],
    dispatched: ['DISPATCHED_BY_VENDOR'],
    transit: IN_FLIGHT,
    delivered: ['DELIVERED'],
    exception: OFF_LADDER,
  }

  // The lifecycle stages each pre-vendor tile selects.
  const STAGES_FOR: Record<string, readonly string[]> = {
    pending: ['RECEIVED', 'BATCHED'],
    atVendor: ['SENT_TO_VENDOR'],
    // The overlay is a Stage value, so its tile goes through the same arm.
    damaged: [STAGE_FILTER_DAMAGED],
  }

  function tileActive(tile: StatTileDef): boolean {
    if (tile.key === 'all') return !anyFilter
    if (tile.key === 'replacements') return billableSel === 'no' && stageSel.length === 0 && statusSel.length === 0
    const stages = STAGES_FOR[tile.key]
    if (stages !== undefined) {
      return stages.length === stageSel.length && stages.every((s) => stageSel.includes(s))
    }
    const want = STATUSES_FOR[tile.key] ?? []
    return want.length > 0 && want.length === statusSel.length && want.every((s) => statusSel.includes(s))
  }

  function onTile(tile: StatTileDef): void {
    if (tile.key === 'all') {
      setSearchParams(new URLSearchParams(), { replace: true })
      return
    }
    const active = tileActive(tile)
    // ONE TILE AT A TIME (23 Aug 2026, at the user's correction): every tile
    // click writes its own axis and clears the other two of {stage, status,
    // billable}, so two tiles can never light together. Clicking the active
    // tile clears it, so a tile is a toggle and never a trap.
    if (tile.key === 'replacements') {
      setParams({ billable: active ? '' : 'no', stage: '', status: '' })
      return
    }
    const stages = STAGES_FOR[tile.key]
    if (stages !== undefined) {
      setParams({ stage: active ? '' : stages.join(','), status: '', billable: '' })
      return
    }
    const want = STATUSES_FOR[tile.key] ?? []
    setParams({ status: active ? '' : want.join(','), stage: '', billable: '' })
  }

  function openDispatch(row: ReportRow): void {
    const id = dispatchIdOf(row)
    if (id !== null) navigate(`/dispatches/${id}`, { state: { fromSearch: searchParams.toString() } })
  }

  // CURATED, not derived from the response's keys. The report also carries
  // programId and shptId; neither is a fact an operator acts on, and programId
  // was occupying a column with a raw uuid in it. shptId is still read for the
  // action gate, just not rendered.
  const columns: GridColumn<ReportRow>[] = [
    {
      key: 'dispatchId',
      header: 'Dispatch ID',
      cell: (r) => {
        const id = dispatchIdOf(r)
        if (id === null) return <span className="text-muted-foreground">-</span>
        return (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={(e) => {
              // The row is clickable too; without this the cell's own click
              // would navigate twice.
              e.stopPropagation()
              openDispatch(r)
            }}
          >
            <CodeChip>{id}</CodeChip>
          </button>
        )
      },
      sortValue: (r) => dispatchIdOf(r) ?? '',
    },
    {
      // Which delivery group this leg is. The old read carried collateral rows
      // and could not label them, so soundbox and paper sat side by side looking
      // identical, which is exactly the confusion the split was meant to end.
      key: 'dispatchGroup',
      header: 'Category',
      cell: (r) => <DispatchGroupBadge group={groupOf(r)} />,
      sortValue: (r) => groupOf(r) ?? '',
    },
    {
      key: 'merchantDisplay',
      header: 'Merchant',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-foreground">{str(r, 'merchantDisplay') ?? '-'}</span>
          {/* A replacement dispatch reads as one at the list grain too (22 Aug
              2026, the badge sweep): the same badge the pool, batch and
              requests pages use, merged onto the report row at the edge. The
              parent's id rides in the title, the same free-of-column rule the
              Held badge follows. */}
          {typeof str(r, 'replacementOfAsgnId') === 'string' && (
            <span
              className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
              title={`Replaces ${str(r, 'replacementOfAsgnId') ?? ''}`}
            >
              Replacement
            </span>
          )}
        </span>
      ),
      sortValue: (r) => str(r, 'merchantDisplay') ?? '',
    },
    {
      // Where this dispatch has reached, which is the column the page was named
      // after and never had.
      key: 'pipelineState',
      header: 'Stage',
      // TWO AXES, ONE CELL (23 Aug 2026).
      //
      // A held dispatch carries pool_status HELD on fulfillment's pool entry AND
      // pipeline_state RECEIVED in analytics, at the same time, in two different
      // tables. The hold used to be drawn in the COURIER STATUS cell, which it
      // has nothing to do with, so on the axis an operator actually scans a held
      // parcel read as an ordinary pending one.
      //
      // Held leads because it is the actionable fact; the real stage stays
      // underneath because that is where the parcel resumes from once released,
      // and showing only "Held" would lose it.
      // DAMAGE RIDES ALONGSIDE THE STAGE, never instead of it (24 Aug 2026). A
      // delivered dispatch whose kit was later damaged is BOTH: the parcel
      // arrived, and a replacement is on its way. Collapsing that to one word
      // would lose whichever half the reader needed.
      // THE OVERLAY LEADS (24 Aug 2026, at the user's direction, same grammar
      // as Held): a dispatch damage was raised against is done as a demand — a
      // replacement carries it forward — so DAMAGED is the answer to "what
      // state is this in", and the courier stage drops to the small line. That
      // small line matters most on a collateral leg, where it is the only place
      // the parcel's own fate shows. Held and Damaged cannot co-occur: damage
      // is flaggable only from the courier rungs, a hold only before batching.
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          {isCancelled(r) ? (
            <>
              <StatusPill value="CANCELLED" />
              <span className="text-[11px] text-muted-foreground">{statusMeta(lifecycleOf(r)).label}</span>
            </>
          ) : isDamaged(r) ? (
            <>
              <StatusPill value="DAMAGED" />
              <span className="text-[11px] text-muted-foreground">{statusMeta(lifecycleOf(r)).label}</span>
            </>
          ) : isHeld(r) ? (
            <>
              <StatusPill value="HELD" />
              <span className="text-[11px] text-muted-foreground">{statusMeta(lifecycleOf(r)).label}</span>
            </>
          ) : (
            <StatusPill value={lifecycleOf(r)} />
          )}
        </span>
      ),
      // Sorted by LADDER position, so sorting walks the lifecycle rather than
      // the alphabet. A held row sorts with the stage it is parked at, not off
      // the end: it IS at that stage, it is simply not moving.
      sortValue: (r) => {
        const at = LIFECYCLE_ORDER.indexOf(lifecycleOf(r) as (typeof LIFECYCLE_ORDER)[number])
        return at === -1 ? LIFECYCLE_ORDER.length : at
      },
    },
    {
      key: 'batchId',
      header: 'Batch',
      cell: (r) => {
        const id = str(r, 'batchId')
        if (id === null) return <span className="text-muted-foreground">not batched yet</span>
        return (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/batches/${id}`, { state: { fromSearch: searchParams.toString() } })
            }}
          >
            <CodeChip>{id}</CodeChip>
          </button>
        )
      },
      sortValue: (r) => str(r, 'batchId') ?? '',
    },
    {
      key: 'bankCode',
      header: 'Bank',
      cell: (r) => bankName(str(r, 'bankCode')),
      sortValue: (r) => bankName(str(r, 'bankCode')),
    },
    {
      key: 'awb',
      header: 'AWB',
      cell: (r) => {
        const awb = str(r, 'awb')
        return awb === null ? <span className="text-muted-foreground">not dispatched</span> : <span className="num">{awb}</span>
      },
      sortValue: (r) => str(r, 'awb') ?? '',
    },
    {
      key: 'courierStatus',
      header: 'Courier status',
      // THE HELD BADGE USED TO BE HERE and moved to the Stage cell (23 Aug
      // 2026), where it belongs. A hold is not a courier status: a held parcel
      // has not been batched, printed or handed over, so the courier has never
      // seen it. Its courier status is empty, and pairing the two implied the
      // courier was involved in the hold.
      cell: (r) => <StatusPill value={str(r, 'courierStatus') ?? ''} />,
      sortValue: (r) => str(r, 'courierStatus') ?? '',
    },
    {
      // Device and SIM together, because that pairing IS the thing an operator
      // needs when chasing an activation, and holding one without the other is
      // no use. The SIM is merged in at the edge from fulfillment: the ICCID
      // never enters the analytics store (S7), so a soundbox row carries it only
      // because this page asked, and a collateral row has neither.
      key: 'devices',
      header: 'Device / SIM',
      cell: (r) => {
        const devices = devicesOf(r)
        const sims = simsOf(r)
        if (devices.length === 0) return <span className="text-muted-foreground">-</span>
        return (
          <span className="flex flex-col gap-0.5">
            {devices.map((d, i) => (
              <span key={d} className="num text-[12px]">
                {d}
                {sims[i] !== undefined && sims[i] !== '' && (
                  <span className="text-muted-foreground"> / {sims[i]}</span>
                )}
              </span>
            ))}
          </span>
        )
      },
      sortValue: (r) => devicesOf(r).join(','),
    },
    {
      key: 'dispatchDate',
      header: 'Dispatched',
      cell: (r) => fmtDateTime(str(r, 'dispatchDate')),
      sortValue: (r) => str(r, 'dispatchDate') ?? '',
    },
    {
      key: 'deliveryDate',
      header: 'Delivered',
      cell: (r) => fmtDateTime(str(r, 'deliveryDate')),
      sortValue: (r) => str(r, 'deliveryDate') ?? '',
    },
  ]

  if (legacyShipmentsView) return <Navigate to="/shipments" replace />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dispatches"
        description="Every dispatch and where it has reached."
        actions={
          // The courier's morning status file is THE daily action on this
          // page - it is what moves every row here - so it is the primary
          // button. The bank file is the occasional one, its effect lands
          // here only after batching, and its primary home is /batches (the
          // page whose pool it fills); it stays reachable but secondary.
          <div className="flex items-center gap-3">
            <WatermarkBadge watermark={watermark?.asOf ?? null} />
            <Button variant="secondary" onClick={() => navigate('/uploads/bank')}>
              <Upload className="size-4" aria-hidden="true" /> Upload bank file
            </Button>
            <Button onClick={() => navigate('/uploads/courier-status')}>
              <Upload className="size-4" aria-hidden="true" /> Courier status
            </Button>
          </div>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      {/* NO GRAIN TABS. Shipments was a tab here until 19 Aug 2026 and is its own
          section now, /shipments, because a parcel's page needs a list to be sent
          back to. ShipmentsPage.tsx records the reasoning. */}
      <StatTiles tiles={tiles} isActive={tileActive} onSelect={onTile} />

      <Card>
        <CardHeader
          title="Dispatches"
          subtitle="One row per dispatch. Open one for its full lifecycle, its batch and its devices."
        />
        <Toolbar className="px-5 pb-1">
          <Field label="Search" htmlFor="dispSearch" className="w-full sm:w-52">
            <Input
              id="dispSearch"
              placeholder="Dispatch ID, merchant, AWB, batch or device"
              value={q}
              onChange={(e) => setParam('q', e.target.value)}
            />
          </Field>
          <Field label="Batch ID" htmlFor="dispBatch" className="w-full sm:w-44">
            <Input
              id="dispBatch"
              placeholder="Any batch"
              value={batch}
              onChange={(e) => setParam('batch', e.target.value)}
            />
          </Field>
          <Field label="Stage" htmlFor="dispStage" className="w-full sm:w-44">
            {/* SINGLE-SELECT, closing on pick (23 Aug 2026, at the user's
                correction): this was a MultiSelect, which stays open by design
                for multi-picking, and on a page where every other dropdown
                closes it read as broken. The `stage` param stays a comma list
                (the tiles write pairs), so the composite "Before the vendor"
                option carries the SAME value the tile writes and the trigger
                renders its label rather than raw CSV. */}
            <SearchSelect
              id="dispStage"
              placeholder="Any stage"
              // Labels from statusMeta, the same source the Stage COLUMN uses,
              // so the dropdown and the table can no longer disagree about what
              // a value is called. Held is a real option rather than a toggle
              // of its own; see STAGE_FILTER_HELD.
              options={[
                { value: '', label: 'Any stage' },
                {
                  value: 'RECEIVED,BATCHED',
                  label: 'Before the vendor',
                  count: searched.filter((r) => ['RECEIVED', 'BATCHED'].includes(lifecycleOf(r))).length,
                },
                ...LIFECYCLE_ORDER.map((stage) => ({
                  value: stage,
                  label: statusMeta(stage).label,
                  count: searched.filter((r) => lifecycleOf(r) === stage).length,
                })),
                {
                  value: STAGE_FILTER_HELD,
                  label: statusMeta(STAGE_FILTER_HELD).label,
                  count: heldCount,
                },
                {
                  value: STAGE_FILTER_DAMAGED,
                  label: statusMeta(STAGE_FILTER_DAMAGED).label,
                  count: damagedCount,
                },
                {
                  value: STAGE_FILTER_CANCELLED,
                  label: 'Cancelled',
                  count: cancelledCount,
                },
              ]}
              value={searchParams.get('stage') ?? ''}
              onChange={(next) => setParams({ stage: next, status: '', billable: '' })}
            />
          </Field>
          <Field label="Category" htmlFor="dispGroup" className="w-full sm:w-40">
            <SearchSelect
              id="dispGroup"
              placeholder="Any category"
              value={groupSel}
              onChange={(v) => setParam('group', v)}
              options={[
                { value: '', label: 'Any category' },
                { value: 'SOUNDBOX', label: 'Soundbox' },
                { value: 'COLLATERAL', label: 'Collateral' },
              ]}
            />
          </Field>
          {/* THE SEPARATE HOLD TOGGLE IS GONE (23 Aug 2026). It lived here
              because a hold is neither a courier status nor a pipeline stage,
              which is true of the STORAGE but was the wrong conclusion for the
              SCREEN: it made an operator learn the platform's table layout to
              find a held parcel. Held is an option in the Stage picker now. */}
          <Field label="Billable" htmlFor="dispBillable" className="w-full sm:w-40">
            <SearchSelect
              id="dispBillable"
              placeholder="Any"
              value={billableSel}
              onChange={(v) => setParam('billable', v)}
              options={[
                { value: '', label: 'Any' },
                { value: 'yes', label: 'Billable' },
                { value: 'no', label: 'Not billable' },
              ]}
            />
          </Field>
          <Field label="Bank" htmlFor="dispBank" className="w-full sm:w-44">
            <SearchSelect
              id="dispBank"
              placeholder="Any bank"
              value={bank}
              onChange={(v) => setParam('bank', v)}
              options={[
                { value: '', label: 'Any bank' },
                ...banks.map((b) => ({ value: b.bankReferenceCode, label: b.displayName })),
              ]}
            />
          </Field>
          <Field label="Courier status" htmlFor="dispStatus" className="w-full sm:w-48">
            {/* Single-select for the same reason as Stage above. The two
                composite options carry the exact values the In transit and
                Failed-or-returned tiles write, so tile and dropdown mirror. */}
            <SearchSelect
              id="dispStatus"
              placeholder="All statuses"
              options={[
                { value: '', label: 'All statuses' },
                {
                  value: IN_FLIGHT.join(','),
                  label: 'In flight',
                  count: searched.filter((r) => (IN_FLIGHT as readonly string[]).includes(str(r, 'courierStatus') ?? '')).length,
                },
                {
                  value: OFF_LADDER.join(','),
                  label: 'Failed or returned',
                  count: searched.filter((r) => (OFF_LADDER as readonly string[]).includes(str(r, 'courierStatus') ?? '')).length,
                },
                ...COURIER_STATUSES.map((s) => ({
                  value: s,
                  label: s,
                  count: searched.filter((r) => str(r, 'courierStatus') === s).length,
                })),
              ]}
              value={searchParams.get('status') ?? ''}
              onChange={(next) => setParams({ status: next, stage: '', billable: '' })}
            />
          </Field>
          <Field label="Dispatched from" htmlFor="dispFrom" className="w-full sm:w-40">
            <Input id="dispFrom" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
          </Field>
          <Field label="To" htmlFor="dispTo" className="w-full sm:w-40">
            <Input id="dispTo" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
          </Field>
          {anyFilter && (
            <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </Button>
          )}
        </Toolbar>
        <DataGrid
          columns={columns}
          rows={tableRows}
          loading={loading}
          getRowKey={(r, i) => dispatchIdOf(r) ?? String(i)}
          onRowClick={openDispatch}
          searchable={false}
          pageSize={20}
          pageSizeOptions={[20, 50, 100]}
          maxBodyHeight="58vh"
          stickyFirstColumn
          emptyTitle={anyFilter ? 'No dispatches match these filters' : 'No dispatches yet'}
          emptyMessage={
            anyFilter
              ? 'Loosen or clear the filters above to see the rest.'
              : 'They appear once a bank request file has been committed and batched.'
          }
        />
      </Card>
    </div>
  )
}
