import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, Check, Copy, PackageCheck, PackageX, Repeat2, Smartphone, Truck, Upload } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { MultiSelect } from '../../components/Picker.js'
import {
  getDevices,
  getMerchants,
  getVendors,
  getDamageCases,
  type UnitInventoryRow,
  type MerchantRow,
  type VendorRow,
  type DamageCaseRow,
} from '../../api/endpoints.js'
import { PageHeader, Card, Field, Input, Button, ErrorNote, Toolbar, StatusPill, CodeChip } from '../../ui/primitives.js'
import { fmtDate, fmtDateTime, fmtRelative } from '../../ui/format.js'
import { useToast } from '../../ui/Toast.js'
import { cn } from '@/lib/utils'

// The inventory workspace (BRD Workflow 3, FR-01a): the device pool, owned end
// to end from this section. Three regions, top to bottom: stat cards (the
// stock question answered before any scrolling), a filter toolbar, and the
// paginated device table. Ingestion lives at /inventory/upload, reached from
// the header - deliberately NOT under the central Uploads index anymore, per
// the 2026-08-12 ruling that the inventory team owns its own insertion.
//
// EVERY number on this screen is computed client-side from the one fetched
// list: aggregates stay banned in ops-read (the precedent the first version of
// this page set), and the same rows the table shows are the rows the cards
// count, so the two can never disagree. The date/manufacturer/search filters
// feed the cards; the status filter deliberately does NOT, because the cards
// ARE the status breakdown - a card that hid itself when its status was
// filtered out would read as data loss.
//
// THE STATUS ORDER IS THE LIFECYCLE, not alphabetical (unit-lifecycle.ts
// spine + terminals). ALLOCATED stays listed even though nothing reaches it
// yet: hiding it would quietly disagree with the domain.
const STATUS_ORDER = [
  'IN_STOCK',
  'ALLOCATED',
  'PRINTED',
  'DISPATCHED',
  'DELIVERED',
  'ACTIVATED',
  'DAMAGED',
  'RETURNED',
] as const

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

interface StatCardDef {
  key: string
  label: string
  hint: string
  icon: typeof Boxes
  tone: string // tailwind text-* for the icon chip
  chip: string // tailwind bg-* for the icon chip
  value: number
  // Which status values clicking this card selects ([] = clear). undefined =
  // not a status slice (the replacements card), handled separately.
  statuses?: string[]
}

function StatCard({ def, active, onClick }: { def: StatCardDef; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border bg-card px-4 py-3 text-left transition-shadow hover:shadow-sm',
        active && 'border-primary ring-2 ring-primary/20',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex size-7 items-center justify-center rounded-lg', def.chip)}>
          <def.icon className={cn('size-4', def.tone)} aria-hidden="true" />
        </span>
        <span className="text-[12.5px] font-medium text-muted-foreground">{def.label}</span>
      </div>
      <p className="num mt-2 text-[26px] font-bold leading-none tracking-tight">{def.value}</p>
      <p className="mt-1 text-[11.5px] text-muted-foreground">{def.hint}</p>
    </button>
  )
}

export function InventoryPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()

  const [rows, setRows] = useState<UnitInventoryRow[]>([])
  const [merchantNames, setMerchantNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [vendors, setVendors] = useState<VendorRow[]>([])
  const [replacementAsgnIds, setReplacementAsgnIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // FILTERS LIVE IN THE URL, not component state: a filtered view survives a
  // refresh and can be pasted to a teammate. Empty params are dropped so the
  // bare /inventory URL stays clean.
  const statusSel = useMemo(() => searchParams.get('status')?.split(',').filter(Boolean) ?? [], [searchParams])
  const mfrSel = useMemo(() => searchParams.get('mfr')?.split(',').filter(Boolean) ?? [], [searchParams])
  const q = searchParams.get('q') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  const replOnly = searchParams.get('repl') === '1'

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

  const anyFilter = statusSel.length > 0 || mfrSel.length > 0 || q !== '' || from !== '' || to !== '' || replOnly

  const load = useCallback(
    async (asRefresh = false): Promise<void> => {
      if (asRefresh) setRefreshing(true)
      else setLoading(true)
      setLoadError(null)
      try {
        const devices = await getDevices(client)
        // Non-array guard, the lesson this page already carries: an error
        // envelope reaching the grid takes the whole screen down.
        setRows(Array.isArray(devices) ? devices : [])
        if (!Array.isArray(devices)) setLoadError('Could not read the device list.')
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load the device inventory.')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [client],
  )

  useEffect(() => {
    void load()
  }, [load])

  // The three name/flag lookups are silent on failure: ids still render, which
  // is what this screen would have shown anyway. They must never error over
  // devices that loaded perfectly well.
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
    getDamageCases(client)
      .then((list: DamageCaseRow[]) => {
        if (cancelled || !Array.isArray(list)) return
        // A damage case's asgnId IS the replacement assignment, so a device
        // whose asgn_id appears here exists as the replacement for a damaged one.
        setReplacementAsgnIds(new Set(list.map((c) => c.asgnId)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const vendorNames = useMemo(() => new Map(vendors.map((v) => [v.id, v.displayName])), [vendors])
  const manufacturers = useMemo(() => vendors.filter((v) => v.type === 'MANUFACTURER'), [vendors])

  // THE FILTERS ARE STAGED, and each facet's option counts come from the stage
  // BEFORE its own filter is applied. Otherwise every unselected option reads 0
  // the moment you pick one, which makes the counts useless exactly when an
  // operator is using them to decide what to look at next.
  //
  // Stage 1: date + search only. Feeds the manufacturer counts.
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
      if (needle !== '' && !(r.deviceSerial ?? '').toLowerCase().includes(needle)) return false
      return true
    })
  }, [rows, from, to, q])

  // Stage 2: + manufacturer. Feeds the stat cards and the status counts. The
  // status filter is deliberately NOT applied here, because the cards ARE the
  // status breakdown: a card that zeroed itself when its status was filtered out
  // would read as data loss.
  const scoped = useMemo(
    () =>
      dateSearchScoped.filter(
        (r) => mfrSel.length === 0 || (r.manufacturerVndr !== null && mfrSel.includes(r.manufacturerVndr)),
      ),
    [dateSearchScoped, mfrSel],
  )

  // Stage 3: + status and the replacements toggle. These are the table rows.
  const tableRows = useMemo(() => {
    return scoped.filter((r) => {
      if (statusSel.length > 0 && !statusSel.includes(r.status)) return false
      if (replOnly && !(r.asgnId !== null && replacementAsgnIds.has(r.asgnId))) return false
      return true
    })
  }, [scoped, statusSel, replOnly, replacementAsgnIds])

  const byStatus = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of scoped) m.set(r.status, (m.get(r.status) ?? 0) + 1)
    return m
  }, [scoped])

  const replacementCount = useMemo(
    () => scoped.filter((r) => r.asgnId !== null && replacementAsgnIds.has(r.asgnId)).length,
    [scoped, replacementAsgnIds],
  )

  const cards: StatCardDef[] = [
    {
      key: 'total',
      label: 'Total devices',
      hint: 'everything ever received',
      icon: Boxes,
      tone: 'text-primary',
      chip: 'bg-primary/10',
      value: scoped.length,
      statuses: [],
    },
    {
      key: 'in_stock',
      label: 'In stock',
      hint: 'ready for the print vendor',
      icon: PackageCheck,
      tone: 'text-emerald-600',
      chip: 'bg-emerald-500/10',
      value: byStatus.get('IN_STOCK') ?? 0,
      statuses: ['IN_STOCK'],
    },
    {
      key: 'dispatched',
      label: 'Dispatched',
      hint: 'on the way or delivered',
      icon: Truck,
      tone: 'text-sky-600',
      chip: 'bg-sky-500/10',
      value: (byStatus.get('DISPATCHED') ?? 0) + (byStatus.get('DELIVERED') ?? 0),
      statuses: ['DISPATCHED', 'DELIVERED'],
    },
    {
      key: 'activated',
      label: 'Activated',
      hint: 'live with a merchant',
      icon: Smartphone,
      tone: 'text-indigo-600',
      chip: 'bg-indigo-500/10',
      value: byStatus.get('ACTIVATED') ?? 0,
      statuses: ['ACTIVATED'],
    },
    {
      key: 'damaged',
      label: 'Damaged',
      hint: 'cannot be reverted',
      icon: PackageX,
      tone: 'text-red-600',
      chip: 'bg-red-500/10',
      value: byStatus.get('DAMAGED') ?? 0,
      statuses: ['DAMAGED'],
    },
    {
      key: 'replacements',
      label: 'Replacements',
      hint: 'sent to replace a damaged kit',
      icon: Repeat2,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: replacementCount,
    },
  ]

  function onCardClick(def: StatCardDef): void {
    if (def.statuses === undefined) {
      // The replacements card toggles its own dedicated slice.
      setParam('repl', replOnly ? '' : '1')
      return
    }
    const same = def.statuses.length === statusSel.length && def.statuses.every((s) => statusSel.includes(s))
    setParam('status', same || def.statuses.length === 0 ? '' : def.statuses.join(','))
    if (def.statuses.length === 0) setParam('repl', '')
  }

  function cardActive(def: StatCardDef): boolean {
    if (def.statuses === undefined) return replOnly
    if (def.statuses.length === 0) return false
    return def.statuses.length === statusSel.length && def.statuses.every((s) => statusSel.includes(s))
  }

  async function copySerial(serial: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(serial)
      setCopiedId(serial)
      setTimeout(() => setCopiedId((cur) => (cur === serial ? null : cur)), 1500)
      toast(`Copied ${serial}`)
    } catch {
      // Clipboard can be denied; the serial is still selectable by hand.
    }
  }

  const columns: GridColumn<UnitInventoryRow>[] = [
    {
      key: 'device',
      header: 'Device',
      sortValue: (r) => r.deviceSerial ?? '',
      cell: (r) => (
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Smartphone className="size-4 text-primary" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="num block truncate font-semibold text-foreground">{r.deviceSerial ?? '-'}</span>
            <span className="block text-[11.5px] text-muted-foreground">{r.productType.toLowerCase()}</span>
          </span>
          {r.deviceSerial !== null && (
            <button
              type="button"
              aria-label={`Copy device id ${r.deviceSerial}`}
              onClick={(e) => {
                e.stopPropagation()
                void copySerial(r.deviceSerial!)
              }}
              className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              {copiedId === r.deviceSerial ? (
                <Check className="size-3.5 text-emerald-600" aria-hidden="true" />
              ) : (
                <Copy className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </span>
      ),
    },
    {
      key: 'sim',
      header: 'SIM',
      sortValue: (r) => r.simNo ?? '',
      cell: (r) => (r.simNo === null ? <span className="text-muted-foreground">-</span> : <CodeChip>{r.simNo}</CodeChip>),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => STATUS_ORDER.indexOf(r.status as (typeof STATUS_ORDER)[number]),
      cell: (r) => (
        <span className="flex items-center gap-1.5">
          <StatusPill value={r.status} />
          {r.asgnId !== null && replacementAsgnIds.has(r.asgnId) && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Replacement
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'manufacturer',
      header: 'Manufacturer',
      sortValue: (r) => (r.manufacturerVndr !== null ? (vendorNames.get(r.manufacturerVndr) ?? '') : ''),
      cell: (r) =>
        r.manufacturerVndr === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          (vendorNames.get(r.manufacturerVndr) ?? <CodeChip>{r.manufacturerVndr}</CodeChip>)
        ),
    },
    {
      key: 'merchant',
      header: 'Merchant',
      sortValue: (r) => (r.printedForMerchant !== null ? (merchantNames.get(r.printedForMerchant) ?? '') : ''),
      cell: (r) =>
        r.printedForMerchant === null ? (
          <span className="text-muted-foreground">unassigned</span>
        ) : (
          (merchantNames.get(r.printedForMerchant) ?? <CodeChip>{r.printedForMerchant}</CodeChip>)
        ),
    },
    {
      key: 'batch',
      header: 'Batch',
      sortValue: (r) => r.batch ?? '',
      cell: (r) =>
        r.batch === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={(e) => {
              e.stopPropagation()
              navigate(`/batches/${r.batch!}`)
            }}
          >
            {r.batch}
          </button>
        ),
    },
    {
      key: 'received',
      header: 'Received',
      sortValue: (r) => r.createdAt,
      cell: (r) => fmtDate(r.createdAt),
    },
    {
      key: 'moved',
      header: 'Last moved',
      sortValue: (r) => r.updatedAt,
      cell: (r) => (
        <span title={fmtDateTime(r.updatedAt)} className="text-muted-foreground">
          {fmtRelative(r.updatedAt)}
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        description="Every device we hold, and where it has reached."
        actions={
          // Refresh was removed 2026-08-13: a browser reload already does this,
          // and a dedicated button for it was one more thing on the screen an
          // operator never reached for.
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/inventory/status-upload')}>
              Update statuses
            </Button>
            <Button onClick={() => navigate('/inventory/upload')}>
              <Upload className="size-4" aria-hidden="true" /> Upload inventory
            </Button>
          </div>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <StatCard key={c.key} def={c} active={cardActive(c)} onClick={() => onCardClick(c)} />
        ))}
      </div>

      <Toolbar className="!mt-10">
        <Field label="Search" htmlFor="invSearch" className="w-full sm:w-44">
          <Input
            id="invSearch"
            placeholder="Device ID…"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
          />
        </Field>
        <Field label="Status" htmlFor="invStatus" className="w-full sm:w-44">
          <MultiSelect
            id="invStatus"
            placeholder="All statuses"
            options={STATUS_ORDER.map((s) => ({ value: s, label: STATUS_LABEL[s] ?? s, count: byStatus.get(s) ?? 0 }))}
            selected={statusSel}
            onChange={(next) => setParam('status', next.join(','))}
          />
        </Field>
        <Field label="Manufacturer" htmlFor="invMfr" className="w-full sm:w-44">
          <MultiSelect
            id="invMfr"
            placeholder="All manufacturers"
            options={manufacturers.map((m) => ({
              value: m.id,
              label: m.displayName,
              count: dateSearchScoped.filter((r) => r.manufacturerVndr === m.id).length,
            }))}
            selected={mfrSel}
            onChange={(next) => setParam('mfr', next.join(','))}
          />
        </Field>
        <Field label="Received from" htmlFor="invFrom" className="w-full sm:w-44">
          <Input id="invFrom" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
        </Field>
        <Field label="To" htmlFor="invTo" className="w-full sm:w-44">
          <Input id="invTo" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
        </Field>
        {anyFilter && (
          <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
      </Toolbar>

      <Card>
        <DataGrid
          columns={columns}
          rows={tableRows}
          getRowKey={(r) => r.id}
          loading={loading}
          refreshing={refreshing}
          searchable={false}
          pageSize={10}
          pageSizeOptions={[10, 25, 50]}
          maxBodyHeight="58vh"
          stickyFirstColumn
          onRowClick={(r) => navigate(`/inventory/device/${r.id}`, { state: { row: r, fromSearch: searchParams.toString() } })}
          emptyTitle={anyFilter ? 'No devices match these filters' : 'No devices in stock yet'}
          emptyMessage={
            anyFilter
              ? 'Loosen or clear the filters above to see the rest of the inventory.'
              : 'Upload a manufacturer inventory file to register the first devices.'
          }
        />
      </Card>
    </div>
  )
}
