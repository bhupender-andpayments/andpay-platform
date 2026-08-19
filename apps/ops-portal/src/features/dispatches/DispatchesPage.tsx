import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, CheckCircle2, PackageX, Send, Truck, Upload, Warehouse } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { SearchSelect, MultiSelect } from '../../components/Picker.js'
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
import { fmtDateTime } from '../../ui/format.js'
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
// The tokens are the analytics rail's own PIPELINE_RANK vocabulary. The labels
// are the operator's words for the same thing: RECEIVED means the request has
// arrived and is waiting for a batch, which is what "pending batch" says.
const LIFECYCLE_LABELS: Record<string, string> = {
  RECEIVED: 'Pending batch',
  BATCHED: 'Batched',
  SENT_TO_VENDOR: 'At print vendor',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
}

const LIFECYCLE_ORDER = ['RECEIVED', 'BATCHED', 'SENT_TO_VENDOR', 'DISPATCHED', 'DELIVERED'] as const

function lifecycleOf(row: ReportRow): string {
  return str(row, 'pipelineState') ?? 'RECEIVED'
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

  const stageSel = useMemo(() => searchParams.get('stage')?.split(',').filter(Boolean) ?? [], [searchParams])
  // ?view=shipments WAS the carrier tab on this page and is now its own section.
  // Links to it are in circulation, so it redirects rather than silently showing
  // the dispatch grid, which would look like the tab had been deleted.
  const legacyShipmentsView = searchParams.get('view') === 'shipments'
  const groupSel = searchParams.get('group') ?? ''

  const anyFilter =
    q !== '' ||
    bank !== '' ||
    batch !== '' ||
    from !== '' ||
    to !== '' ||
    statusSel.length > 0 ||
    stageSel.length > 0 ||
    groupSel !== ''

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
    // Batch narrows BEFORE the text search and before the tiles, so the tiles
    // read as "this batch's status breakdown" rather than the whole report's.
    // Substring and case-insensitive, because the id is long enough that a
    // partial paste is the normal case.
    const byBatch =
      batch === ''
        ? byGroup
        : byGroup.filter((r) => (str(r, 'batchId') ?? '').toLowerCase().includes(batch.trim().toLowerCase()))
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
  }, [rows, q, groupSel, batch])

  // Stage 2: + status. These are the grid's rows; the tiles deliberately read
  // from `searched` so picking one status does not zero the other five.
  const tableRows = useMemo(
    () =>
      searched
        .filter((r) => statusSel.length === 0 || statusSel.includes(str(r, 'courierStatus') ?? ''))
        .filter((r) => stageSel.length === 0 || stageSel.includes(lifecycleOf(r))),
    [searched, statusSel, stageSel],
  )

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
      value: searched.filter((r) => ['RECEIVED', 'BATCHED'].includes(lifecycleOf(r))).length,
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
  }

  function tileActive(tile: StatTileDef): boolean {
    if (tile.key === 'all') return !anyFilter
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
    const stages = STAGES_FOR[tile.key]
    // Clicking the tile that is already the filter clears it, so a tile is a
    // toggle and never a trap. The two axes are mutually exclusive as filters:
    // selecting a lifecycle stage clears any courier selection and the reverse,
    // because a row before the vendor has no courier status to also match.
    if (stages !== undefined) {
      setParams({ stage: active ? '' : stages.join(','), status: '' })
      return
    }
    const want = STATUSES_FOR[tile.key] ?? []
    setParams({ status: active ? '' : want.join(','), stage: '' })
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
      cell: (r) => <span className="font-medium text-foreground">{str(r, 'merchantDisplay') ?? '-'}</span>,
      sortValue: (r) => str(r, 'merchantDisplay') ?? '',
    },
    {
      // Where this dispatch has reached, which is the column the page was named
      // after and never had.
      key: 'pipelineState',
      header: 'Stage',
      cell: (r) => <StatusPill value={lifecycleOf(r)} />,
      // Sorted by LADDER position, so sorting walks the lifecycle rather than
      // the alphabet.
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
            <MultiSelect
              id="dispStage"
              placeholder="Any stage"
              options={LIFECYCLE_ORDER.map((stage) => ({
                value: stage,
                label: LIFECYCLE_LABELS[stage] ?? stage,
                count: searched.filter((r) => lifecycleOf(r) === stage).length,
              }))}
              selected={stageSel}
              onChange={(next) => setParams({ stage: next.join(','), status: '' })}
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
            <MultiSelect
              id="dispStatus"
              placeholder="All statuses"
              options={COURIER_STATUSES.map((s) => ({
                value: s,
                label: s,
                count: searched.filter((r) => str(r, 'courierStatus') === s).length,
              }))}
              selected={statusSel}
              onChange={(next) => setParam('status', next.join(','))}
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
