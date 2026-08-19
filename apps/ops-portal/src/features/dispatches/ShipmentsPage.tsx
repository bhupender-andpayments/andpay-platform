import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { SearchSelect } from '../../components/Picker.js'
import { getDispatches, getVendors, type DispatchRow, type VendorRow } from '../../api/endpoints.js'
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
} from '../../ui/primitives.js'
import { fmtDateTime } from '../../ui/format.js'
import { COURIER_STATUSES } from '../dashboards/courierStatuses.js'

// THE CARRIER VIEW, ONE ROW PER AWB, AT ITS OWN ROUTE: /shipments.
//
// It has been three things. Two cards stacked on one page, the lower one titled
// only "Shipments" with no account of how it differed. Then a TAB on
// /dispatches?view=shipments (decision D13), which was right about the grain
// being a choice and wrong about where the choice lives. Now a section.
//
// WHY THE TAB DID NOT HOLD (19 Aug 2026, at the user's direction). A parcel's own
// page is a DESTINATION: an operator opens it from a courier's website with an
// AWB in hand, and when they leave it they want the shipment list back. Under a
// tab there was no such place to return to. The back link read "Dispatches" and
// dropped them on a different grain's table, because the only route that existed
// was the dispatch list carrying a query parameter. A view you can arrive at, be
// sent back to, and bookmark is a route, not a tab.
//
// The two grains still genuinely disagree about what a row is, which is what the
// tab was defending: one dispatch can travel under two AWBs, so it appears twice
// here and once there. Separate routes say that more plainly than a toggle did.
//
// The filter keys keep their `shpt` prefix. They no longer share a URL with the
// dispatch grid's own `status`/`q`/`from`, so nothing would collide, but the
// prefix is what every saved link and pasted filter in circulation already uses.

export function ShipmentsPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Shipments" description="The carrier view, one row per AWB. A dispatch travelling as a soundbox kit and a separate standee appears here twice, under both." />
      <ShipmentsCard />
    </div>
  )
}

/** The table itself. See this file's header for why it is a route now. */
function ShipmentsCard() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [shipments, setShipments] = useState<DispatchRow[]>([])
  const [vendors, setVendors] = useState<readonly VendorRow[]>([])
  // URL-backed like every other filter on this page (all keys prefixed 'shpt'
  // so they cannot collide with the dispatch grid's own 'status'/'q'/'from'): a
  // filtered carrier view survives a reload and can be pasted to a teammate.
  const status = searchParams.get('shpt') ?? ''
  // The AWB is its own labelled field rather than a general "AWB or courier"
  // box. It is the handle an operator arrives holding off a courier's website,
  // and mixing it with the courier name meant a carrier's name could not be
  // filtered separately from a tracking number that happened to contain it.
  const awbQ = searchParams.get('shptq') ?? ''
  const courierSel = searchParams.get('shptc') ?? ''
  const shptFrom = searchParams.get('shptf') ?? ''
  const shptTo = searchParams.get('shptt') ?? ''
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const setShipmentParam = useCallback(
    (key: 'shpt' | 'shptq' | 'shptc' | 'shptf' | 'shptt', value: string) => {
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

  // The roster, so the Courier column can show a name. Silent on failure: it only
  // makes a column nicer, and a carrier view that refuses to render because a
  // vendor read blipped is worse than one showing an id.
  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setVendors(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  function courierName(id: string | null): string {
    if (id === null) return '-'
    return vendors.find((v) => v.id === id)?.displayName ?? id
  }

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
            navigate(`/shipments/${r.id}`)
          }}
        >
          {r.awb}
        </button>
      ),
      sortValue: (r) => r.awb,
    },
    { key: 'contents', header: 'Contents', cell: (r) => contents(r), sortValue: (r) => contents(r) },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} />, sortValue: (r) => r.status },
    {
      // The NAME, not the vndr_ id (decision D13). The id was rendered raw here,
      // which told an operator nothing and made the column unsearchable by the
      // only handle they have for a courier: what it is called.
      key: 'courierPartner',
      header: 'Courier',
      cell: (r) => courierName(r.courierPartner),
      sortValue: (r) => courierName(r.courierPartner),
    },
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
  // grid's own search above: the status filter narrows on the server, the rest
  // narrows what came back.
  const needle = awbQ.trim().toLowerCase()
  const searched = shipments
    .filter((r) => needle === '' || r.awb.toLowerCase().includes(needle))
    .filter((r) => courierSel === '' || r.courierPartner === courierSel)
    // Date-only compare on the ISO timestamp's leading 10 characters, which is
    // what the two date inputs produce. Lexical works because ISO-8601 sorts
    // chronologically, and it avoids a timezone shift from parsing to Date.
    .filter((r) => shptFrom === '' || r.dispatchDate.slice(0, 10) >= shptFrom)
    .filter((r) => shptTo === '' || r.dispatchDate.slice(0, 10) <= shptTo)

  const anyShipmentFilter =
    status !== '' || awbQ !== '' || courierSel !== '' || shptFrom !== '' || shptTo !== ''

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
        <Field label="AWB" htmlFor="shipmentSearch" className="w-full sm:w-52">
          <Input
            id="shipmentSearch"
            placeholder="Tracking number"
            value={awbQ}
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
        {/* The roster filtered to couriers, by id, because that is what the row
            actually carries. Showing every vendor type here would offer
            manufacturers and print vendors that can never match a shipment. */}
        <Field label="Courier" htmlFor="shipmentCourier" className="w-full sm:w-44">
          <SearchSelect
            id="shipmentCourier"
            placeholder="Any courier"
            value={courierSel}
            onChange={(v) => setShipmentParam('shptc', v)}
            options={[
              { value: '', label: 'Any courier' },
              ...vendors.filter((v) => v.type === 'COURIER').map((v) => ({ value: v.id, label: v.displayName })),
            ]}
          />
        </Field>
        <Field label="Dispatched from" htmlFor="shipmentFrom" className="w-full sm:w-40">
          <Input
            id="shipmentFrom"
            type="date"
            value={shptFrom}
            onChange={(e) => setShipmentParam('shptf', e.target.value)}
          />
        </Field>
        <Field label="To" htmlFor="shipmentTo" className="w-full sm:w-40">
          <Input id="shipmentTo" type="date" value={shptTo} onChange={(e) => setShipmentParam('shptt', e.target.value)} />
        </Field>
        {anyShipmentFilter && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev)
                  for (const key of ['shpt', 'shptq', 'shptc', 'shptf', 'shptt']) next.delete(key)
                  return next
                },
                { replace: true },
              )
            }}
          >
            Clear filters
          </Button>
        )}
      </Toolbar>
      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
      <DataGrid
        columns={columns}
        rows={searched}
        loading={loading}
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/shipments/${r.id}`)}
        searchable={false}
        emptyTitle={anyShipmentFilter ? 'No shipments match these filters' : 'No shipments yet'}
        emptyMessage={
          anyShipmentFilter
            ? 'Loosen or clear the filters above to see the rest.'
            : 'The first committed return sheet creates them.'
        }
        pageSize={20}
        pageSizeOptions={[20, 50, 100]}
      />
    </Card>
  )
}
