import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, CheckCircle2, PackageX, Send, Truck, Upload, Warehouse } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { SearchSelect, MultiSelect } from '../../components/Picker.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import {
  getBankMasters,
  getDispatches,
  getReport,
  type BankMasterRow,
  type DispatchRow,
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

  const anyFilter = q !== '' || bank !== '' || from !== '' || to !== '' || statusSel.length > 0

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
      const result = await getReport(client, 'soundbox-delivery', filters)
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
    if (q === '') return rows
    const needle = q.toLowerCase()
    return rows.filter((r) =>
      [dispatchIdOf(r), str(r, 'merchantDisplay'), str(r, 'awb')].some(
        (v) => v !== null && v.toLowerCase().includes(needle),
      ),
    )
  }, [rows, q])

  // Stage 2: + status. These are the grid's rows; the tiles deliberately read
  // from `searched` so picking one status does not zero the other five.
  const tableRows = useMemo(
    () => (statusSel.length === 0 ? searched : searched.filter((r) => statusSel.includes(str(r, 'courierStatus') ?? ''))),
    [searched, statusSel],
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
      key: 'awaiting',
      label: 'Awaiting vendor',
      hint: 'no AWB reported yet',
      icon: Warehouse,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: searched.filter((r) => str(r, 'awb') === null).length,
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

  // Which statuses a tile stands for. 'all' clears, and 'awaiting' is not a
  // status at all (it is the absence of an AWB), so it owns its own param.
  const STATUSES_FOR: Record<string, readonly string[]> = {
    all: [],
    awaiting: [],
    dispatched: ['DISPATCHED_BY_VENDOR'],
    transit: IN_FLIGHT,
    delivered: ['DELIVERED'],
    exception: OFF_LADDER,
  }

  function tileActive(tile: StatTileDef): boolean {
    const want = STATUSES_FOR[tile.key] ?? []
    if (tile.key === 'all') return !anyFilter
    return want.length > 0 && want.length === statusSel.length && want.every((s) => statusSel.includes(s))
  }

  function onTile(tile: StatTileDef): void {
    if (tile.key === 'all') {
      setSearchParams(new URLSearchParams(), { replace: true })
      return
    }
    const want = STATUSES_FOR[tile.key] ?? []
    // Clicking the tile that is already the filter clears it, so a tile is a
    // toggle and never a trap.
    setParam('status', tileActive(tile) ? '' : want.join(','))
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
      key: 'merchantDisplay',
      header: 'Merchant',
      cell: (r) => <span className="font-medium text-foreground">{str(r, 'merchantDisplay') ?? '-'}</span>,
      sortValue: (r) => str(r, 'merchantDisplay') ?? '',
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

      <StatTiles tiles={tiles} isActive={tileActive} onSelect={onTile} />

      {/* The dispatch list mirrors the Shipments card below: one card, a
          heading that says what a row IS, and the filters inside it. The
          filters used to float between the tiles and a bare grid, which
          left this region the only one on the page without a name. */}
      <Card>
        <CardHeader
          title="Dispatches"
          subtitle="One row per dispatch. Open one for its full lifecycle, its batch and its devices."
        />
        <Toolbar className="px-5 pb-1">
          <Field label="Search" htmlFor="dispSearch" className="w-full sm:w-52">
            <Input
              id="dispSearch"
              placeholder="Dispatch ID, merchant or AWB…"
              value={q}
              onChange={(e) => setParam('q', e.target.value)}
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

      <ShipmentsCard />
    </div>
  )
}

// The carrier view, one row per AWB. Kept as its own region because it answers a
// different question from the grid above ("where is this parcel" rather than
// "what did this merchant get"), and because one dispatch can travel under two
// AWBs, so collapsing them would lose a parcel.
function ShipmentsCard() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [shipments, setShipments] = useState<DispatchRow[]>([])
  // URL-backed like every other filter on this page ('shpt'/'shptq', their own
  // keys so they cannot collide with the dispatch grid's 'status'/'q'): a
  // filtered carrier view survives a reload and can be pasted to a teammate.
  const status = searchParams.get('shpt') ?? ''
  const q = searchParams.get('shptq') ?? ''
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const setShipmentParam = useCallback(
    (key: 'shpt' | 'shptq', value: string) => {
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

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getDispatches(client, status)
      // A non-array body reaching the grid throws during render and would take
      // the whole page with it, including the dispatch list above.
      if (Array.isArray(rows)) setShipments(rows)
      else {
        setShipments([])
        setError('Could not read the shipment list.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load shipments.')
    } finally {
      setLoading(false)
    }
  }, [client, status])

  useEffect(() => {
    void load()
  }, [load])

  // Both flags false is a real and reportable state, not an error to hide: a
  // shipment whose devices are not paired yet, or whose collateral link has not
  // arrived. Saying so beats an empty cell, which reads as a rendering fault.
  function contents(r: DispatchRow): string {
    if (r.hasUnits && r.hasCollateral) return 'Devices + collateral'
    if (r.hasUnits) return 'Devices'
    if (r.hasCollateral) return 'Collateral'
    return 'Nothing linked'
  }

  const columns: GridColumn<DispatchRow>[] = [
    {
      key: 'awb',
      header: 'AWB',
      cell: (r) => (
        <button
          type="button"
          className="num text-xs underline underline-offset-2"
          onClick={(e) => {
            e.stopPropagation()
            navigate(`/dispatches/shipment/${r.id}`)
          }}
        >
          {r.awb}
        </button>
      ),
      sortValue: (r) => r.awb,
    },
    { key: 'contents', header: 'Contents', cell: (r) => contents(r), sortValue: (r) => contents(r) },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} />, sortValue: (r) => r.status },
    { key: 'courierPartner', header: 'Courier', cell: (r) => r.courierPartner ?? '-', sortValue: (r) => r.courierPartner ?? '' },
    { key: 'dispatchDate', header: 'Dispatched', cell: (r) => fmtDateTime(r.dispatchDate), sortValue: (r) => r.dispatchDate },
    {
      key: 'statusAt',
      header: 'Last update',
      cell: (r) => (r.statusAt === null ? '-' : fmtDateTime(r.statusAt)),
      sortValue: (r) => r.statusAt ?? '',
    },
    { key: 'statusSource', header: 'Source', cell: (r) => r.statusSource ?? '-', sortValue: (r) => r.statusSource ?? '' },
  ]

  // Client-side, over the rows already fetched, exactly like the dispatch
  // grid's own search above: the status filter narrows on the server, the text
  // narrows what came back.
  const needle = q.trim().toLowerCase()
  const searched =
    needle === ''
      ? shipments
      : shipments.filter((r) =>
          [r.awb, r.courierPartner].some((v) => v !== null && v.toLowerCase().includes(needle)),
        )

  return (
    <Card>
      {/* Same grammar as the Dispatches card above: heading, one-line subtitle,
          labelled filters in a row under it. The status filter used to sit
          top-right in the header, which made the page's two cards disagree
          about where filters live. */}
      <CardHeader
        title="Shipments"
        subtitle="The carrier view, one row per AWB. A dispatch travelling as a soundbox kit and a separate standee appears here twice, under both."
      />
      <Toolbar className="px-5 pb-1">
        <Field label="Search" htmlFor="shipmentSearch" className="w-full sm:w-52">
          <Input
            id="shipmentSearch"
            placeholder="AWB or courier…"
            value={q}
            onChange={(e) => setShipmentParam('shptq', e.target.value)}
          />
        </Field>
        <Field label="Carrier status" htmlFor="shipmentStatus" className="w-full sm:w-48">
          <SearchSelect
            id="shipmentStatus"
            placeholder="All"
            value={status}
            onChange={(v) => setShipmentParam('shpt', v)}
            options={[{ value: '', label: 'All' }, ...COURIER_STATUSES.map((s) => ({ value: s, label: s }))]}
          />
        </Field>
      </Toolbar>
      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
      <DataGrid
        columns={columns}
        rows={searched}
        loading={loading}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/dispatches/shipment/${r.id}`)}
        searchable={false}
        emptyTitle="No shipments yet"
        emptyMessage="The first committed return sheet creates them."
        pageSize={20}
        pageSizeOptions={[20, 50, 100]}
      />
    </Card>
  )
}
