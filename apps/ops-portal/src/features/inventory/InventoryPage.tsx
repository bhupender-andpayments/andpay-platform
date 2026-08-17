import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, Check, Copy, Download, PackageCheck, PackageX, Pencil, Smartphone, Truck, Upload } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { UnitStatusEditDialog } from './UnitStatusEditDialog.js'
import { UNIT_STATUS_ORDER as STATUS_ORDER, STATUS_LABEL, legalNextStatuses } from './unitStatus.js'
import { MultiSelect, SearchSelect } from '../../components/Picker.js'
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
import { buildSampleInventoryFile, SAMPLE_ROW_COUNT } from './sampleInventory.js'
import { saveBlob } from '../../lib/saveBlob.js'
import { fmtDate, fmtDateTime } from '../../ui/format.js'
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
// THE STATUS VOCABULARY IS NOT DEFINED HERE. The spine, the terminals, the
// labels and the legal forward moves all live in ./unitStatus.ts, mirroring the
// server's unit-lifecycle.ts, so this screen's facet and the edit dialog can
// never offer a status the write would reject. Read that file's header for why
// ACTIVATED is absent from it (D-16: activation is its own axis, `activatedAt`,
// which the Activated stat card and the Activation column below both read).
//
// STATUS IS EDITABLE IN PLACE, from the Status column. The bulk status-upload
// tool that used to sit in this header is gone (2026-08-14): device and dispatch
// statuses move together in the flows that own them, so the only status write an
// operator still makes by hand is the one-device correction, which belongs on
// the row it corrects rather than behind a file upload.

interface StatCardDef {
  key: string
  label: string
  hint: string
  icon: typeof Boxes
  tone: string // tailwind text-* for the icon chip
  chip: string // tailwind bg-* for the icon chip
  value: number
  // Which status values clicking this card selects ([] = the Total card, which
  // clears every card slice). undefined = not a status slice: the one card in
  // that category is Activated, which (since D-16) is its own axis rather than
  // a value the status column can hold.
  statuses?: string[]
  // The URL param this card toggles when `statuses` is undefined.
  param?: 'act'
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
  // The row whose status is being corrected, or null. One dialog for the whole
  // grid: mounting one per row would mount a hundred.
  const [editingUnit, setEditingUnit] = useState<UnitInventoryRow | null>(null)
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
  // The source axis: '' (all), 'replacement' (sent to replace a damaged kit,
  // non-billable) or 'fresh' (ordinary billable stock). It replaced the old
  // repl=1 toggle when the Replacements card became the Source dropdown, which
  // can name BOTH halves of the split instead of only one.
  const srcSel = searchParams.get('src') ?? ''
  // D-16: the activation slice, its own axis rather than a status value.
  const actOnly = searchParams.get('act') === '1'

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

  const anyFilter =
    statusSel.length > 0 || mfrSel.length > 0 || q !== '' || from !== '' || to !== '' || srcSel !== '' || actOnly

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

  // Stage 3: + status, the source axis, and the activation toggle. These are
  // the table rows.
  const tableRows = useMemo(() => {
    return scoped.filter((r) => {
      if (statusSel.length > 0 && !statusSel.includes(r.status)) return false
      const isReplacement = r.asgnId !== null && replacementAsgnIds.has(r.asgnId)
      if (srcSel === 'replacement' && !isReplacement) return false
      if (srcSel === 'fresh' && isReplacement) return false
      if (actOnly && r.activatedAt === null) return false
      return true
    })
  }, [scoped, statusSel, srcSel, actOnly, replacementAsgnIds])

  const byStatus = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of scoped) m.set(r.status, (m.get(r.status) ?? 0) + 1)
    return m
  }, [scoped])

  // Counted off the ACTIVATION AXIS, not off byStatus: there is no ACTIVATED
  // status left to count (D-16). Same `scoped` stage as the status cards, so the
  // card totals stay comparable.
  const activatedCount = useMemo(() => scoped.filter((r) => r.activatedAt !== null).length, [scoped])

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
      value: activatedCount,
      param: 'act',
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
  ]

  // CARDS ARE ONE-AT-A-TIME. Each pick clears the other card axes, so exactly
  // one card carries the highlight: several cards lit at once read as a
  // combined filter the table is not actually applying in that shape. The
  // dropdowns below stay independently composable; only the cards are
  // exclusive. Total is the "everything" view: clicking it clears every card
  // slice, and it wears the highlight whenever no slice is applied, which is
  // what makes it read as clickable at rest.
  // ONE setSearchParams call per click, writing all three keys together.
  // Sequential setParam calls do NOT compose inside a single handler: each
  // computes from the same stale location and issues its own navigation, so
  // the last one wins and silently drops the others' changes. That is the
  // exact bug that made the Total card feel dead (its clears cancelled each
  // other out).
  function onCardClick(def: StatCardDef): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('status')
        next.delete('act')
        next.delete('src')
        if (def.statuses === undefined) {
          // The activation axis card, toggling.
          if (!actOnly) next.set('act', '1')
        } else if (def.statuses.length > 0) {
          const same = def.statuses.length === statusSel.length && def.statuses.every((s) => statusSel.includes(s))
          if (!same) next.set('status', def.statuses.join(','))
        }
        return next
      },
      { replace: true },
    )
  }

  function cardActive(def: StatCardDef): boolean {
    if (def.statuses === undefined) return actOnly
    // Total: active exactly when no card slice is applied.
    if (def.statuses.length === 0) return statusSel.length === 0 && !actOnly && srcSel === ''
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
    // THE SOUNDBOX ID IS THE `unit_` WIRE ID (Q4, ruled 12 Aug 2026). Workflow A
    // step 4 asks that a registered device carry a system-generated Soundbox ID.
    // The `unit_` id already IS that: minted server-side at registration, typed
    // and prefixed through @andpay/ids, stable for the device's whole life. No
    // new identifier was invented (that would be a corpus I4 decision) and
    // nothing was migrated; this column only SHOWS what the read already
    // returned.
    //
    // Both ids are listed because they answer different questions: the Soundbox
    // ID is ours and is what an internal reference means, while the Device ID is
    // the manufacturer's serial an operator reads off the box and searches by.
    // Device is first for that reason, and keeps the copy button.
    {
      key: 'id',
      header: 'Soundbox ID',
      sortValue: (r) => r.id,
      cell: (r) => <CodeChip>{r.id}</CodeChip>,
    },
    {
      key: 'sim',
      header: 'SIM',
      sortValue: (r) => r.simNo ?? '',
      cell: (r) => (r.simNo === null ? <span className="text-muted-foreground">-</span> : <CodeChip>{r.simNo}</CodeChip>),
    },
    // D-16: activation is its OWN column, next to Status rather than inside it.
    // A device reads DISPATCHED and Activated at once when the CWD got there
    // before the courier's update did, and that pairing is exactly what an
    // operator needs to see rather than have flattened into one value.
    {
      key: 'activatedAt',
      header: 'Activation',
      sortValue: (r) => (r.activatedAt === null ? 0 : new Date(r.activatedAt).getTime()),
      // The PILL ONLY: in a list the fact is whether it is activated, and the
      // instant beside it was noise repeated on every row. The exact time
      // lives on the device page's Activity card, one click away. Sorting
      // still uses the real instant below, so ordering is unaffected.
      cell: (r) =>
        r.activatedAt === null ? (
          <span className="text-muted-foreground">not activated</span>
        ) : (
          <StatusPill value="ACTIVATED" />
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => STATUS_ORDER.indexOf(r.status as (typeof STATUS_ORDER)[number]),
      cell: (r) => (
        <span className="group/status flex items-center gap-1.5">
          <StatusPill value={r.status} />
          {r.asgnId !== null && replacementAsgnIds.has(r.asgnId) && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Replacement
            </span>
          )}
          {/* The correction lives on the value it corrects. Hidden outright on a
              terminal device rather than shown disabled: there is no forward
              move left, so an affordance would only promise one. */}
          {legalNextStatuses(r.status).length > 0 && (
            <button
              type="button"
              title="Change status"
              aria-label={`Change status of ${r.deviceSerial ?? r.id}`}
              className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground group-hover/status:text-muted-foreground"
              onClick={(e) => {
                // The row itself navigates to the device page; editing here
                // must not also do that.
                e.stopPropagation()
                setEditingUnit(r)
              }}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
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
      cell: (r) => <span className="text-muted-foreground">{fmtDateTime(r.updatedAt)}</span>,
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
            {/*
              TESTING AID (see ./sampleInventory.ts). Downloads one CSV of
              freshly minted serials, so the upload flow can be demoed
              repeatedly without reseeding: the checked-in demo assets carry
              fixed serials and every upload after the first one correctly
              flags them as duplicates. Ghost variant so it reads as a utility
              beside the real action, never as the primary path.
            */}
            <Button
              variant="ghost"
              onClick={() => {
                const sample = buildSampleInventoryFile()
                saveBlob(sample.filename, new Blob([sample.csv], { type: 'text/csv;charset=utf-8' }))
                toast(`Sample file with ${SAMPLE_ROW_COUNT} new devices downloaded.`)
              }}
            >
              <Download className="size-4" aria-hidden="true" /> Sample file
            </Button>
            <Button onClick={() => navigate('/inventory/upload')}>
              <Upload className="size-4" aria-hidden="true" /> Upload inventory
            </Button>
          </div>
        }
      />

      {loadError !== null ? <ErrorNote>{loadError}</ErrorNote> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
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
        <Field label="Source" htmlFor="invSrc" className="w-full sm:w-44">
          <SearchSelect
            id="invSrc"
            placeholder="All sources"
            clearable
            options={[
              { value: 'fresh', label: 'Fresh (billable)', count: scoped.length - replacementCount },
              { value: 'replacement', label: 'Replacement', count: replacementCount },
            ]}
            value={srcSel}
            onChange={(v) => setParam('src', v)}
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

      {/* Patched in place rather than refetched: the operator stays where they
          were, on the same page of the same filtered list, and the stat cards
          recompute from `rows` anyway so they follow the change for free. */}
      {editingUnit !== null && (
        <UnitStatusEditDialog
          unit={editingUnit}
          open
          onOpenChange={(next) => {
            if (!next) setEditingUnit(null)
          }}
          onSaved={(status) => {
            const editedId = editingUnit.id
            setRows((prev) => prev.map((r) => (r.id === editedId ? { ...r, status } : r)))
          }}
        />
      )}
    </div>
  )
}
