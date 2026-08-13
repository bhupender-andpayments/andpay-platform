import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { MultiSelect } from '../../components/Picker.js'
import { Card, CardHeader, Field, Input, Button, ErrorNote, Toolbar } from '../../ui/primitives.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'
import { statusMeta } from '../../ui/format.js'
import { IncludeResolvedToggle } from './shared.js'

// THE QUEUE TABLE, once, for all three queues. Before this each tab rendered a
// bare table with no pagination, no filters and no search: the intake queue in
// the review had 24 rows on one unbroken scroll, its Vendor column printed a raw
// `vndr_01kzs...`, and there was no way to ask "show me only the duplicate-serial
// rows". Three copies of that would have been three places to fix it.
//
// It owns the whole toolbar-plus-grid composition, so a tab supplies only its
// columns and its rows. Filters live in the URL for the same reason Inventory's
// do: a filtered queue is then a link an operator can send. Switching tabs
// navigates without a query string, so one tab's filters never silently apply to
// another's rows.
//
// Filtering is CLIENT-SIDE over the already-fetched list. The reads take only
// `includeResolved`; adding filter params would push aggregation into ops-read,
// where it is banned.

/** What QueueTable needs of a row to filter and count it. */
export interface QueueRowBase {
  id: string
  reasonCode: string
  createdAt: string
  resolvedAt: string | null
}

export interface QueueTableProps<T extends QueueRowBase> {
  title: string
  rows: readonly T[]
  columns: ReadonlyArray<GridColumn<T>>
  loading?: boolean
  error?: string | null
  emptyMessage: string
  includeResolved: boolean
  onIncludeResolvedChange(next: boolean): void
  /** The text the search box matches against, per row. */
  searchText(row: T): string
  searchPlaceholder?: string
  /** Supply when rows carry a vendor, to offer a vendor filter with real names. */
  vendorOf?(row: T): string | null
  /** Rendered to the right of the filters (e.g. a refresh button). */
  actions?: ReactNode
}

export function QueueTable<T extends QueueRowBase>({
  title,
  rows,
  columns,
  loading = false,
  error = null,
  emptyMessage,
  includeResolved,
  onIncludeResolvedChange,
  searchText,
  searchPlaceholder = 'Search…',
  vendorOf,
  actions,
}: QueueTableProps<T>) {
  const { client } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [vendors, setVendors] = useState<VendorRow[]>([])

  // Silent on failure, like every other name lookup in the portal: a missing
  // vendor list leaves ids showing, which is what this screen showed before.
  useEffect(() => {
    if (vendorOf === undefined) return
    let cancelled = false
    getVendors(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setVendors(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, vendorOf])

  const reasonSel = useMemo(() => searchParams.get('reason')?.split(',').filter(Boolean) ?? [], [searchParams])
  const vendorSel = useMemo(() => searchParams.get('vendor')?.split(',').filter(Boolean) ?? [], [searchParams])
  const q = searchParams.get('q') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''

  function setParam(key: string, value: string): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === '') next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  }

  const anyFilter = reasonSel.length > 0 || vendorSel.length > 0 || q !== '' || from !== '' || to !== ''

  // Staged like Inventory's: each facet's counts come from the set BEFORE its own
  // filter, so an unselected option never misreports as 0.
  const dateSearchScoped = useMemo(() => {
    const fromT = from !== '' ? new Date(`${from}T00:00:00`).getTime() : null
    const toT = to !== '' ? new Date(`${to}T23:59:59.999`).getTime() : null
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (fromT !== null || toT !== null) {
        const t = new Date(r.createdAt).getTime()
        if (fromT !== null && t < fromT) return false
        if (toT !== null && t > toT) return false
      }
      if (needle !== '' && !searchText(r).toLowerCase().includes(needle)) return false
      return true
    })
  }, [rows, from, to, q, searchText])

  const afterVendor = useMemo(() => {
    if (vendorOf === undefined || vendorSel.length === 0) return dateSearchScoped
    return dateSearchScoped.filter((r) => {
      const v = vendorOf(r)
      return v !== null && vendorSel.includes(v)
    })
  }, [dateSearchScoped, vendorSel, vendorOf])

  const visible = useMemo(
    () => (reasonSel.length === 0 ? afterVendor : afterVendor.filter((r) => reasonSel.includes(r.reasonCode))),
    [afterVendor, reasonSel],
  )

  // Reason options come from the ROWS, not a hardcoded list: the reason
  // vocabulary is server-owned and grows (the four duplicate codes the device
  // upload raises were added this week), so a fixed list here would go stale
  // silently. statusMeta gives the same humanised label the pill shows.
  const reasonOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of afterVendor) counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1)
    return [...counts.entries()]
      .map(([value, count]) => ({ value, label: statusMeta(value).label, count }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [afterVendor])

  const vendorOptions = useMemo(() => {
    if (vendorOf === undefined) return []
    const counts = new Map<string, number>()
    for (const r of dateSearchScoped) {
      const v = vendorOf(r)
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const names = new Map(vendors.map((v) => [v.id, v.displayName]))
    return [...counts.entries()]
      .map(([value, count]) => ({ value, label: names.get(value) ?? value, count }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [dateSearchScoped, vendorOf, vendors])

  return (
    <div className="space-y-4">
      <Toolbar>
        <Field label="Search" htmlFor="qSearch">
          <Input
            id="qSearch"
            placeholder={searchPlaceholder}
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
            className="w-48"
          />
        </Field>
        <Field label="Reason" htmlFor="qReason">
          <MultiSelect
            id="qReason"
            placeholder="All reasons"
            className="w-48"
            options={reasonOptions}
            selected={reasonSel}
            onChange={(next) => setParam('reason', next.join(','))}
          />
        </Field>
        {vendorOf !== undefined && (
          <Field label="Vendor" htmlFor="qVendor">
            <MultiSelect
              id="qVendor"
              placeholder="All vendors"
              className="w-44"
              options={vendorOptions}
              selected={vendorSel}
              onChange={(next) => setParam('vendor', next.join(','))}
            />
          </Field>
        )}
        <Field label="Created from" htmlFor="qFrom">
          <Input id="qFrom" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
        </Field>
        <Field label="To" htmlFor="qTo">
          <Input id="qTo" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
        </Field>
        {anyFilter && (
          <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
        {actions}
      </Toolbar>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader
          title={title}
          subtitle={`${visible.length} ${visible.length === 1 ? 'row' : 'rows'}${
            visible.length !== rows.length ? ` of ${rows.length}` : ''
          }`}
          actions={<IncludeResolvedToggle checked={includeResolved} onChange={onIncludeResolvedChange} />}
        />
        <DataGrid
          columns={columns}
          rows={visible}
          getRowKey={(r) => r.id}
          loading={loading}
          searchable={false}
          pageSize={10}
          pageSizeOptions={[10, 25, 50]}
          maxBodyHeight="52vh"
          stickyFirstColumn
          emptyTitle={anyFilter ? 'No rows match these filters' : emptyMessage}
          emptyMessage={anyFilter ? 'Loosen or clear the filters above.' : undefined}
        />
      </Card>
    </div>
  )
}
