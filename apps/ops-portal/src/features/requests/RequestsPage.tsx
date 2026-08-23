import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Download, Layers, Repeat, Rows3, Smartphone, Tag, Upload } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { getRequestLegs, type RequestLegRow } from '../../api/endpoints.js'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import { PageHeader, Card, CardHeader, ErrorNote, StatusPill, CodeChip, Field, Input, Button, Toolbar } from '../../ui/primitives.js'
import { SearchSelect } from '../../components/Picker.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { fmtDateTime } from '../../ui/format.js'
import { useToast } from '../../ui/Toast.js'
import { buildSampleBankFile, SAMPLE_BANK_ROW_COUNT } from '../uploads/sampleBankRequests.js'
import { saveBlob } from '../../lib/saveBlob.js'

/**
 * MERCHANT REQUESTS, the grain the platform has always had and never shown
 * (DAMAGE.md, 21 Aug 2026).
 *
 * A bank file row is ONE request that can mint TWO dispatches: a soundbox
 * consignment and a collateral consignment, which ship separately because they
 * are different parcels. `source_event_id` is what holds them together, and it
 * is load-bearing rather than incidental: the pool groups by it and the
 * minimum-lot batching gate counts DISTINCT values of it.
 *
 * WHY A PAGE FOR IT. Every existing screen is per-dispatch, so an operator
 * holding a merchant's complaint could see one leg and had to guess which other
 * rows belonged with it. That guesswork is also where the damage flow went
 * wrong: flagging both legs of one request used to produce two unrelated pool
 * rows, because the replacement took a fresh key instead of the parent's.
 *
 * GROUPED CLIENT-SIDE, from flat rows. The curated read modules are row-level
 * only by construction (no GROUP BY, architecture.test.ts check 7), and the pool
 * page already groups this same key the same way, so this follows the
 * established shape rather than inventing one.
 *
 * 23 Aug 2026: tiles, filters and the fixed-height grid, matching the treatment
 * already given to Inventory and Merchants (this is the busiest front door of
 * the three: every dispatch traces back to a row here). Counts stay computed
 * client-side from the one fetched list, same "no aggregates in ops-read" rule
 * this page has always followed.
 */

interface RequestGroup {
  sourceEventId: string
  merchantDisplayName: string
  bankReferenceCode: string
  bankDisplayName: string
  branchCode: string | null
  vpaValue: string
  legs: readonly RequestLegRow[]
  /** Oldest leg's creation, which is when the bank asked. */
  requestedAt: string
  /** True when every leg is a replacement, i.e. the request IS a replacement round. */
  isReplacement: boolean
  /** Any leg carrying a live damage case. */
  hasOpenCase: boolean
}

export function groupByRequest(legs: readonly RequestLegRow[]): RequestGroup[] {
  const byKey = new Map<string, RequestLegRow[]>()
  for (const leg of legs) {
    const bucket = byKey.get(leg.sourceEventId)
    if (bucket === undefined) byKey.set(leg.sourceEventId, [leg])
    else bucket.push(leg)
  }
  return [...byKey.values()]
    .map((group) => {
      const first = group[0]!
      return {
        sourceEventId: first.sourceEventId,
        merchantDisplayName: first.merchantDisplayName,
        bankReferenceCode: first.bankReferenceCode,
        bankDisplayName: first.bankDisplayName,
        branchCode: first.branchCode,
        vpaValue: first.vpaValue,
        // SOUNDBOX before COLLATERAL, so a request always reads in the same
        // order rather than in whatever order the rows arrived.
        legs: [...group].sort((a, b) => a.dispatchGroup.localeCompare(b.dispatchGroup)),
        requestedAt: group.reduce((min, l) => (l.createdAt < min ? l.createdAt : min), first.createdAt),
        isReplacement: group.every((l) => l.replacementOfAsgnId !== null),
        hasOpenCase: group.some((l) => l.caseStatus !== null && l.caseStatus !== 'Closed'),
      }
    })
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
}

/** What the merchant asked for, in the words an operator uses. */
function kitOf(legs: readonly RequestLegRow[]): string {
  const parts: string[] = []
  if (legs.some((l) => l.soundbox)) parts.push('Soundbox')
  const standees = legs.reduce((n, l) => n + l.standeeCount, 0)
  const stickers = legs.reduce((n, l) => n + l.stickerCount, 0)
  if (standees > 0) parts.push(`${String(standees)} standee`)
  if (stickers > 0) parts.push(`${String(stickers)} sticker`)
  return parts.length === 0 ? '-' : parts.join(', ')
}

export function RequestsPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()

  const [legs, setLegs] = useState<readonly RequestLegRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getRequestLegs(client)
      setLegs(Array.isArray(rows) ? rows : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load requests.')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupByRequest(legs), [legs])

  // FILTERS LIVE IN THE URL, not component state: a filtered view survives a
  // refresh and can be pasted to a teammate. Empty params are dropped so the
  // bare /requests URL stays clean. Same convention as Inventory.
  const q = searchParams.get('q') ?? ''
  const bankSel = searchParams.get('bank') ?? ''
  const kitSel = useMemo(() => searchParams.get('kit')?.split(',').filter(Boolean) ?? [], [searchParams])
  const replacementSel = searchParams.get('replacement') ?? ''
  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''

  // BATCHED, for handlers that move two axes at once. Two sequential setParam
  // calls in one handler LOSE the first write: react-router's functional
  // updater reads the location as it stood at call time, not the previous
  // updater's result, so the second call starts from params that never saw the
  // first change. The tile clicks hit exactly that (23 Aug 2026).
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
  const setParam = useCallback((key: string, value: string) => setParams({ [key]: value }), [setParams])

  const anyFilter = q !== '' || bankSel !== '' || kitSel.length > 0 || replacementSel !== '' || from !== '' || to !== ''

  // THE FILTERS ARE STAGED, and each facet's option counts come from the stage
  // BEFORE its own filter is applied, the same reasoning Inventory's filters
  // use: an unselected option must not read 0 the moment a sibling is picked.
  //
  // Stage 1: date + search only. Feeds the Bank filter's counts.
  const dateSearchScoped = useMemo(() => {
    const fromT = from !== '' ? new Date(`${from}T00:00:00`).getTime() : null
    const toT = to !== '' ? new Date(`${to}T23:59:59.999`).getTime() : null
    const needle = q.trim().toLowerCase()
    return groups.filter((g) => {
      if (fromT !== null || toT !== null) {
        const t = new Date(g.requestedAt).getTime()
        if (fromT !== null && t < fromT) return false
        if (toT !== null && t > toT) return false
      }
      if (needle !== '') {
        const haystack = `${g.merchantDisplayName} ${g.bankDisplayName} ${g.branchCode ?? ''} ${g.vpaValue}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [groups, from, to, q])

  // Stage 2: + bank + replacement. Feeds the tiles, which are the Kit filter's
  // own breakdown and must not zero out when Kit itself narrows the table.
  const scoped = useMemo(
    () =>
      dateSearchScoped.filter((g) => {
        if (bankSel !== '' && g.bankDisplayName !== bankSel) return false
        if (replacementSel === 'yes' && !g.isReplacement) return false
        if (replacementSel === 'no' && g.isReplacement) return false
        return true
      }),
    [dateSearchScoped, bankSel, replacementSel],
  )

  // The stage the REPLACEMENT tile counts off: bank applied, replacement NOT,
  // for the same reason bankOptions counts off the stage before bank. A facet
  // that zeroes out when you click it cannot be clicked back.
  const bankScoped = useMemo(
    () => dateSearchScoped.filter((g) => bankSel === '' || g.bankDisplayName === bankSel),
    [dateSearchScoped, bankSel],
  )
  const replacementCount = useMemo(() => bankScoped.filter((g) => g.isReplacement).length, [bankScoped])

  // Stage 3: + kit. The table rows.
  const tableRows = useMemo(() => {
    if (kitSel.length === 0) return scoped
    return scoped.filter((g) => {
      if (kitSel.includes('soundbox') && g.legs.some((l) => l.soundbox)) return true
      if (kitSel.includes('standee') && g.legs.some((l) => l.standeeCount > 0)) return true
      if (kitSel.includes('sticker') && g.legs.some((l) => l.stickerCount > 0)) return true
      return false
    })
  }, [scoped, kitSel])

  const soundboxCount = useMemo(() => scoped.filter((g) => g.legs.some((l) => l.soundbox)).length, [scoped])
  const standeeTotal = useMemo(
    () => scoped.reduce((n, g) => n + g.legs.reduce((m, l) => m + l.standeeCount, 0), 0),
    [scoped],
  )
  const stickerTotal = useMemo(
    () => scoped.reduce((n, g) => n + g.legs.reduce((m, l) => m + l.stickerCount, 0), 0),
    [scoped],
  )

  // Bank options for the filter, counted off the stage BEFORE bank itself
  // applies. Keyed on bankDisplayName rather than bankReferenceCode, which is
  // the bank FILE's own code, not the Bank Master's (the same fix Merchants
  // needed: a real bank must never show at count 0 in this dropdown).
  const bankOptions = useMemo(() => {
    const names = [...new Set(dateSearchScoped.map((g) => g.bankDisplayName))].sort((a, b) => a.localeCompare(b))
    return names.map((name) => ({
      value: name,
      label: name,
      count: dateSearchScoped.filter((g) => g.bankDisplayName === name).length,
    }))
  }, [dateSearchScoped])

  const tiles: StatTileDef[] = [
    {
      key: 'total',
      label: 'Total requests',
      hint: 'unique bank requests, by source event ID',
      icon: Layers,
      tone: 'text-primary',
      chip: 'bg-primary/10',
      value: scoped.length,
    },
    {
      key: 'soundbox',
      label: 'Soundbox requests',
      hint: 'requests asking for a soundbox',
      icon: Smartphone,
      tone: 'text-indigo-600',
      chip: 'bg-indigo-500/10',
      value: soundboxCount,
    },
    {
      // THE REPLACEMENT TILE (23 Aug 2026, ops-team ask): damage-driven demand
      // is the number the business watches, so it is a tile rather than only a
      // filter. Amber, matching every REPLACEMENT pill on this portal. Its
      // count comes from bankScoped so clicking it never zeroes its own facet.
      key: 'replacements',
      label: 'Replacement requests',
      hint: 'raised from a damage case, not billable',
      icon: Repeat,
      tone: 'text-amber-600',
      chip: 'bg-amber-500/10',
      value: replacementCount,
    },
    {
      key: 'standees',
      label: 'Standees requested',
      hint: 'total standee count across every request',
      icon: Rows3,
      tone: 'text-emerald-600',
      chip: 'bg-emerald-500/10',
      value: standeeTotal,
    },
    {
      key: 'stickers',
      label: 'Stickers requested',
      hint: 'total sticker count across every request',
      icon: Tag,
      tone: 'text-sky-600',
      chip: 'bg-sky-500/10',
      value: stickerTotal,
    },
  ]

  // EVERY tile filters, ONE at a time (23 Aug 2026, at the user's correction:
  // Inventory semantics everywhere tiles appear). The kit tiles and the
  // replacement tile own different params, so each click writes its own and
  // clears the other; two tiles can never light together, and clicking the
  // active one clears it. The Merchants tile is GONE for the same reason: a
  // button that filters nothing in a row of buttons that do is the
  // inconsistency this fixes.
  const KIT_FOR: Record<string, string> = { soundbox: 'soundbox', standees: 'standee', stickers: 'sticker' }
  function tileActive(t: StatTileDef): boolean {
    if (t.key === 'total') return kitSel.length === 0 && replacementSel === ''
    if (t.key === 'replacements') return replacementSel === 'yes' && kitSel.length === 0
    const kit = KIT_FOR[t.key]
    return kit !== undefined && kitSel.length === 1 && kitSel[0] === kit && replacementSel === ''
  }
  function onTileClick(t: StatTileDef): void {
    const active = tileActive(t)
    if (t.key === 'total') {
      setParams({ kit: '', replacement: '' })
      return
    }
    if (t.key === 'replacements') {
      setParams({ replacement: active ? '' : 'yes', kit: '' })
      return
    }
    const kit = KIT_FOR[t.key]
    if (kit === undefined) return
    setParams({ kit: active ? '' : kit, replacement: '' })
  }

  const columns: GridColumn<RequestGroup>[] = [
    {
      key: 'merchant',
      header: 'Merchant',
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{r.merchantDisplayName}</span>
          {/* A replacement round reads as one, so an operator is not left to
              infer it from a non-billable flag on a child row. */}
          {r.isReplacement && (
            <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Replacement
            </span>
          )}
        </span>
      ),
      sortValue: (r) => r.merchantDisplayName,
    },
    {
      key: 'bank',
      // DEC-14: bank reads as Name (CODE) everywhere, so a bare integer is never
      // mistaken for a name.
      header: 'Bank',
      cell: (r) => `${r.bankDisplayName} (${r.bankReferenceCode})`,
      sortValue: (r) => r.bankDisplayName,
    },
    {
      key: 'branch',
      header: 'Branch code',
      cell: (r) => (r.branchCode === null ? <span className="text-muted-foreground">-</span> : <CodeChip>{r.branchCode}</CodeChip>),
      sortValue: (r) => r.branchCode ?? '',
    },
    {
      key: 'vpa',
      header: 'VPA',
      cell: (r) => <span className="font-mono text-[12px]">{r.vpaValue}</span>,
      sortValue: (r) => r.vpaValue,
    },
    {
      key: 'kit',
      header: 'Kit',
      cell: (r) => kitOf(r.legs),
    },
    {
      key: 'legs',
      header: 'Dispatches',
      // THE POINT OF THE PAGE: one row, its parcels inside it.
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {r.legs.map((l) => (
            <button
              key={l.asgnId}
              type="button"
              className="rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-accent"
              onClick={(ev) => {
                ev.stopPropagation()
                navigate(`/dispatches/${l.asgnId}`)
              }}
              title={l.asgnId}
            >
              {l.dispatchGroup === 'SOUNDBOX' ? 'Soundbox' : 'Collateral'}
            </button>
          ))}
        </span>
      ),
      sortValue: (r) => r.legs.length,
    },
    {
      key: 'case',
      header: 'Damage',
      cell: (r) =>
        r.hasOpenCase ? <StatusPill value="Open" /> : <span className="text-muted-foreground">-</span>,
      sortValue: (r) => (r.hasOpenCase ? 1 : 0),
    },
    {
      key: 'requestedAt',
      header: 'Requested',
      cell: (r) => fmtDateTime(r.requestedAt),
      sortValue: (r) => r.requestedAt,
    },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Requests"
        description="What the bank asked for, one row per merchant request. Its parcels are inside."
        actions={
          <div className="flex items-center gap-2">
            {/* TESTING AID (see ../uploads/sampleBankRequests.ts). Same
                sample-file affordance BankIngestPage offers, repeated here
                because this is the screen a request actually starts from. */}
            <Button
              variant="ghost"
              onClick={() => {
                const sample = buildSampleBankFile()
                saveBlob(sample.filename, new Blob([sample.csv], { type: 'text/csv;charset=utf-8' }))
                toast(`Sample file with ${SAMPLE_BANK_ROW_COUNT} new requests downloaded.`)
              }}
            >
              <Download className="size-4" aria-hidden="true" /> Sample file
            </Button>
            <Button onClick={() => navigate('/uploads/bank')}>
              <Upload className="size-4" aria-hidden="true" /> Upload bank file
            </Button>
          </div>
        }
      />
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <StatTiles tiles={tiles} isActive={tileActive} onSelect={onTileClick} />

      <Toolbar className="!mt-10">
        <Field label="Search" htmlFor="reqSearch" className="w-full sm:w-48">
          <Input
            id="reqSearch"
            placeholder="Merchant, bank, branch, VPA…"
            value={q}
            onChange={(e) => setParam('q', e.target.value)}
          />
        </Field>
        <Field label="Bank" htmlFor="reqBank" className="w-full sm:w-56">
          <SearchSelect
            id="reqBank"
            placeholder="All banks"
            clearable
            options={bankOptions}
            value={bankSel}
            onChange={(v) => setParam('bank', v)}
          />
        </Field>
        <Field label="Kit" htmlFor="reqKit" className="w-full sm:w-44">
          {/* Single-select, closing on pick (23 Aug 2026): one vocabulary with
              the tiles above, which write the same `kit` param one value at a
              time. The param stays a comma list in the reading code so an old
              multi-value URL still filters. */}
          <SearchSelect
            id="reqKit"
            placeholder="All kit types"
            options={[
              { value: '', label: 'All kit types' },
              { value: 'soundbox', label: 'Soundbox', count: soundboxCount },
              { value: 'standee', label: 'Standee', count: scoped.filter((g) => g.legs.some((l) => l.standeeCount > 0)).length },
              { value: 'sticker', label: 'Sticker', count: scoped.filter((g) => g.legs.some((l) => l.stickerCount > 0)).length },
            ]}
            value={searchParams.get('kit') ?? ''}
            onChange={(v) => setParam('kit', v)}
          />
        </Field>
        <Field label="Replacement" htmlFor="reqRepl" className="w-full sm:w-40">
          <SearchSelect
            id="reqRepl"
            placeholder="All requests"
            clearable
            options={[
              { value: 'yes', label: 'Replacement only' },
              { value: 'no', label: 'Fresh only' },
            ]}
            value={replacementSel}
            onChange={(v) => setParam('replacement', v)}
          />
        </Field>
        <Field label="Requested from" htmlFor="reqFrom" className="w-full sm:w-44">
          <Input id="reqFrom" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
        </Field>
        <Field label="To" htmlFor="reqTo" className="w-full sm:w-44">
          <Input id="reqTo" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
        </Field>
        {anyFilter && (
          <Button variant="ghost" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        )}
      </Toolbar>

      <Card>
        <CardHeader title="Merchant requests" subtitle="Newest first." />
        <DataGrid
          columns={columns}
          rows={tableRows}
          getRowKey={(r) => r.sourceEventId}
          loading={loading}
          searchable={false}
          pageSize={10}
          pageSizeOptions={[10, 25, 50]}
          maxBodyHeight="58vh"
          stickyFirstColumn
          onRowClick={(r) => navigate(`/requests/${r.sourceEventId}`, { state: { fromSearch: searchParams.toString() } })}
          emptyTitle={anyFilter ? 'No requests match these filters' : 'No requests yet'}
          emptyMessage={
            anyFilter
              ? 'Loosen or clear the filters above to see the rest of the requests.'
              : 'A bank file upload is what creates these.'
          }
        />
      </Card>
    </div>
  )
}
