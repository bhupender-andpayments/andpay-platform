import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Boxes, CheckCircle2, Hourglass, PackageX, Printer, Send, Truck, Warehouse, Zap } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getReport,
  getTiles,
  type ReportCell,
  type ReportFilters,
  type ReportRow,
  type TileName,
  type TileSet,
} from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { StatTiles, type StatTileDef } from '../../ui/StatTiles.js'
import { PageHeader, Card, CardHeader, CardBody, Field, Input, Toolbar, ErrorNote } from '../../ui/primitives.js'
import { ExceptionSurface } from './ExceptionSurface.js'
import { RecentBatches } from './RecentBatches.js'
import { TrendChart, type TrendBucket } from './TrendChart.js'
import { IconChevron, IconUploads } from '../../ui/icons.js'
import { fmtNumber } from '../../ui/format.js'
import { cn } from '@/lib/utils'

// The Command Center, rebuilt 2026-08-15 to the operations team's brief: keep
// it SIMPLE, and put one date-range filter on top that every number obeys.
// The previous version showed eight all-time tiles that no filter could touch,
// and the version before that was a wall of graphs the team rejected.
//
// TWO HALVES, TWO TIME-BASES, and the layout draws the line. The TOP half
// (six cards + the chart) answers "what happened in this window": derived
// client-side from the soundbox-delivery report, server-filtered by the
// chosen dates - the exact read and derivations the Dispatches page ships, so
// the two screens can never disagree. The BOTTOM half is LIVE and ignores the
// filter entirely: the pipeline strip (queue depths), Needs attention (stuck
// rows) and Recent batches all have no date axis, sit together below the
// windowed content, and say so in their own copy.
//
// ONE CHART, ADAPTIVE BUCKETS. The team wants a trend without a crowded
// scatter of points: the bucket follows the range (up to 2 weeks -> daily,
// up to ~3 months -> weekly, beyond -> monthly), so a year never renders 365
// bars and two days never render one useless pair of blobs.

function str(row: ReportRow, key: string): string | null {
  const value: ReportCell | undefined = row[key]
  return typeof value === 'string' && value !== '' ? value : null
}

const IN_FLIGHT = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] as const
const OFF_LADDER = ['FAILED', 'RETURNED'] as const

const DAY_MS = 86_400_000

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Today minus (days-1), as the yyyy-mm-dd the date inputs and the read use. */
function daysAgo(days: number): string {
  return isoDay(new Date(Date.now() - (days - 1) * DAY_MS))
}

const PRESETS = [
  { key: 'today', label: 'Today', from: () => daysAgo(1) },
  { key: '7d', label: '7 days', from: () => daysAgo(7) },
  { key: '30d', label: '30 days', from: () => daysAgo(30) },
  { key: '90d', label: '90 days', from: () => daysAgo(90) },
  { key: 'all', label: 'All time', from: () => '' },
] as const

type BucketUnit = 'day' | 'week' | 'month'

// Thresholds picked so each preset lands on a readable bar count: a week is
// days (7 bars), a month is weeks (4-5 bars), 90 days is MONTHS (~4 bars) -
// thirteen weekly bars at 90 days was exactly the crowding the team refused.
function chooseUnit(rangeDays: number): BucketUnit {
  if (rangeDays <= 14) return 'day'
  if (rangeDays <= 45) return 'week'
  return 'month'
}

/** Monday of the week holding `d`, so weekly buckets are calendar weeks. */
function mondayOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - day * DAY_MS)
}

function bucketKey(iso: string, unit: BucketUnit): string {
  const d = new Date(iso)
  if (unit === 'day') return isoDay(d)
  if (unit === 'week') return isoDay(mondayOf(d))
  return iso.slice(0, 7)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function bucketLabel(key: string, unit: BucketUnit): string {
  if (unit === 'month') {
    const [yy, mm] = key.split('-')
    return `${MONTHS[Number(mm) - 1] ?? mm!} ${yy!}`
  }
  const d = new Date(key)
  const label = `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''}`
  // Spelled out, not "w/c": an axis label an operator has to decode is noise.
  return unit === 'week' ? `Week of ${label}` : label
}

/**
 * Every bucket from `fromIso` to `toIso` inclusive, EMPTY BUCKETS KEPT: a week
 * with zero dispatches is a fact worth a gap in the chart, not a bucket to
 * silently skip (skipping it would make a quiet fortnight look like one busy
 * continuous run).
 */
function buildBuckets(rows: readonly ReportRow[], fromIso: string, toIso: string, unit: BucketUnit): TrendBucket[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (let t = new Date(fromIso).getTime(); t <= new Date(toIso).getTime(); t += DAY_MS) {
    const key = bucketKey(new Date(t).toISOString(), unit)
    if (!seen.has(key)) {
      seen.add(key)
      order.push(key)
    }
  }
  const dispatched = new Map<string, number>()
  const delivered = new Map<string, number>()
  for (const row of rows) {
    const dd = str(row, 'dispatchDate')
    if (dd !== null) {
      const k = bucketKey(dd, unit)
      if (seen.has(k)) dispatched.set(k, (dispatched.get(k) ?? 0) + 1)
    }
    const del = str(row, 'deliveryDate')
    if (del !== null) {
      const k = bucketKey(del, unit)
      if (seen.has(k)) delivered.set(k, (delivered.get(k) ?? 0) + 1)
    }
  }
  return order.map((key) => ({
    key,
    label: bucketLabel(key, unit),
    dispatched: dispatched.get(key) ?? 0,
    delivered: delivered.get(key) ?? 0,
  }))
}

export function TilesPage() {
  const { client } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // The window lives in the URL, the portal idiom: a filtered dashboard
  // survives a reload and can be pasted to a teammate. No params = last 30
  // days; 'from' empty with a marker = all time.
  const from = searchParams.get('from') ?? daysAgo(30)
  const to = searchParams.get('to') ?? isoDay(new Date())
  const allTime = searchParams.get('all') === '1'

  const setRange = useCallback(
    (nextFrom: string, nextTo: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('all')
          if (nextFrom === '') {
            next.delete('from')
            next.delete('to')
            next.set('all', '1')
          } else {
            next.set('from', nextFrom)
            next.set('to', nextTo)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const [rows, setRows] = useState<ReportRow[]>([])
  const [tiles, setTiles] = useState<TileSet | null>(null)
  const [watermark, setWatermark] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const filters: ReportFilters = allTime ? {} : { from, to }
    getReport(client, 'soundbox-delivery', filters)
      .then((result) => {
        if (cancelled) return
        setRows(Array.isArray(result.rows) ? result.rows : [])
        setWatermark(result.watermark.asOf)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load the window.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, from, to, allTime])

  // The live pipeline strip, loaded separately and silently degrading: the
  // date-filtered half of the page must not die with the tiles read.
  useEffect(() => {
    let cancelled = false
    getTiles(client)
      .then((res) => {
        if (!cancelled) setTiles(res.tiles)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  const countOf = useCallback(
    (statuses: readonly string[]) => rows.filter((r) => statuses.includes(str(r, 'courierStatus') ?? '')).length,
    [rows],
  )

  // The SAME six numbers, with the SAME definitions, as the Dispatches page's
  // own tiles - so the dashboard and the worklist can never disagree.
  const cards: StatTileDef[] = [
    { key: 'all', label: 'Dispatches', hint: 'created in this window', icon: Boxes, tone: 'text-primary', chip: 'bg-primary/10', value: rows.length },
    { key: 'awaiting', label: 'Awaiting vendor', hint: 'no AWB reported yet', icon: Warehouse, tone: 'text-amber-600', chip: 'bg-amber-500/10', value: rows.filter((r) => str(r, 'awb') === null).length },
    { key: 'dispatched', label: 'Dispatched', hint: 'handed to the courier', icon: Send, tone: 'text-sky-600', chip: 'bg-sky-500/10', value: countOf(['DISPATCHED_BY_VENDOR']) },
    { key: 'transit', label: 'In transit', hint: 'picked up, on its way', icon: Truck, tone: 'text-indigo-600', chip: 'bg-indigo-500/10', value: countOf(IN_FLIGHT) },
    { key: 'delivered', label: 'Delivered', hint: 'courier confirmed delivery', icon: CheckCircle2, tone: 'text-emerald-600', chip: 'bg-emerald-500/10', value: countOf(['DELIVERED']) },
    { key: 'exception', label: 'Failed or returned', hint: 'needs a decision', icon: PackageX, tone: 'text-red-600', chip: 'bg-red-500/10', value: countOf(OFF_LADDER) },
  ]

  // Every card is a door into the list it counts, carrying the same window.
  function onCard(card: StatTileDef): void {
    const params = new URLSearchParams()
    if (!allTime) {
      params.set('from', from)
      params.set('to', to)
    }
    const statuses: Record<string, readonly string[]> = {
      dispatched: ['DISPATCHED_BY_VENDOR'],
      transit: IN_FLIGHT,
      delivered: ['DELIVERED'],
      exception: OFF_LADDER,
    }
    const want = statuses[card.key]
    if (want !== undefined) params.set('status', want.join(','))
    navigate(`/dispatches?${params.toString()}`)
  }

  const trend = useMemo(() => {
    // All time has no chosen edges, so the data supplies them: first dispatch
    // to today.
    let fromIso = from
    let toIso = to
    if (allTime) {
      const dates = rows.map((r) => str(r, 'dispatchDate')).filter((d): d is string => d !== null)
      if (dates.length === 0) return { buckets: [] as TrendBucket[], unit: 'day' as BucketUnit }
      fromIso = isoDay(new Date(dates.reduce((min, d) => (d < min ? d : min))))
      toIso = isoDay(new Date())
    }
    const rangeDays = Math.max(1, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / DAY_MS) + 1)
    const unit = chooseUnit(rangeDays)
    return { buckets: buildBuckets(rows, fromIso, toIso, unit), unit }
  }, [rows, from, to, allTime])

  const activePreset = allTime ? 'all' : PRESETS.find((p) => p.key !== 'all' && p.from() === from && to === isoDay(new Date()))?.key

  return (
    <div className="space-y-6">
      <PageHeader
        title="Command Center"
        description="The dispatch pipeline at a glance. Pick a window; every number below follows it."
        actions={
          <>
            <WatermarkBadge watermark={watermark} />
            <Link
              to="/uploads/bank"
              className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/80"
            >
              <IconUploads width={16} height={16} />
              Upload bank file
            </Link>
          </>
        }
      />

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {/* THE window. Presets for the ranges an operator actually asks about,
          date inputs for everything else. */}
      <Toolbar>
        <div className="flex items-center gap-1 rounded-full border bg-card p-1">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setRange(p.from(), isoDay(new Date()))}
              className={cn(
                'rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                activePreset === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Field label="From" htmlFor="ccFrom" className="w-full sm:w-40">
          <Input id="ccFrom" type="date" value={allTime ? '' : from} onChange={(e) => setRange(e.target.value, to)} />
        </Field>
        <Field label="To" htmlFor="ccTo" className="w-full sm:w-40">
          <Input id="ccTo" type="date" value={allTime ? '' : to} onChange={(e) => setRange(allTime ? daysAgo(30) : from, e.target.value)} />
        </Field>
      </Toolbar>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {cards.map((c) => (
            <div key={c.key} className="skeleton h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <StatTiles tiles={cards} isActive={() => false} onSelect={onCard} />
      )}

      <Card>
        <CardHeader
          title="Dispatches over time"
          subtitle="Handed to the courier, and delivered, inside the chosen window."
        />
        <CardBody className="pt-0">
          {loading ? <div className="skeleton h-48 rounded-lg" /> : <TrendChart buckets={trend.buckets} unitLabel={trend.unit} />}
        </CardBody>
      </Card>

      {/* BELOW THE WINDOW: the live half of the page. Everything from here
          down ignores the date filter - queue depths, stuck rows and the
          latest batches have no date axis - and sits together so the boundary
          between "the chosen window" above and "live" below stays visible. */}
      {/* Right now carries four stages and needs the room; Needs attention is
          a short list and reads fine narrow.
          The damage-case counts card was REMOVED from this column on 17 Aug
          2026: it was the only thing under Needs attention, so a short
          exception list left it stranded beside a tall neighbour, and damage is
          not what this screen is being used for. /damage-cases still owns those
          counts and the nav still reaches it. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        {tiles !== null && <PipelineNow tiles={tiles} />}
        <ExceptionSurface />
      </div>

      <RecentBatches />
    </div>
  )
}

// The one strip that is NOT on the date filter, and says so: live queue
// depths have no date axis. Each stage is a door into its drilldown, and each
// carries the same tinted icon-chip language the stat cards use, so the row
// scans by colour before any number is read.
const RAIL = [
  { label: 'Awaiting batch', key: 'pendingQrAwaitingBatch', icon: Hourglass, tone: 'text-amber-600', chip: 'bg-amber-500/10' },
  { label: 'Vendor pickup', key: 'pendingPrintVendorPickup', icon: Printer, tone: 'text-sky-600', chip: 'bg-sky-500/10' },
  { label: 'In transit', key: 'dispatchedNotDelivered', icon: Truck, tone: 'text-indigo-600', chip: 'bg-indigo-500/10' },
  { label: 'Awaiting activation', key: 'deliveredNotActivated', icon: Zap, tone: 'text-emerald-600', chip: 'bg-emerald-500/10' },
] as const satisfies ReadonlyArray<{
  label: string
  key: TileName
  icon: typeof Hourglass
  tone: string
  chip: string
}>

function tileCount(tiles: TileSet, key: TileName): number {
  const v = tiles[key]
  if (typeof v === 'number') return v
  return typeof v === 'object' && v !== null ? v.count : 0
}

// DamageCasesCard WAS HERE and is gone with its card (17 Aug 2026). It was the
// D-31 damage-case counts read live from TMS, three tiles linking into
// /damage-cases?status=. The screen that owns those counts still shows them, so
// nothing is lost but the duplicate. getDamageCaseSummary keeps its other
// caller and stays in endpoints.ts.

function PipelineNow({ tiles }: { tiles: TileSet }) {
  return (
    // The testid rides a wrapper: the Card primitive forwards no extra props.
    <div data-testid="lifecycle-rail">
      <Card className="overflow-hidden">
        <CardHeader title="Right now" subtitle="Live queue depths. Not affected by the date filter above." />
        <div className="flex items-stretch gap-1.5 overflow-x-auto px-5 pb-5">
          {RAIL.map((stage, i) => (
            <div key={stage.key} className="flex min-w-0 flex-1 items-center gap-1.5">
              <Link
                to={`/reports?tile=${stage.key}`}
                className="group flex min-w-0 flex-1 flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow"
              >
                <span className={cn('flex size-7 items-center justify-center rounded-lg', stage.chip)}>
                  <stage.icon className={cn('size-4', stage.tone)} aria-hidden="true" />
                </span>
                <span className="num text-[26px] font-semibold leading-none text-foreground">
                  {fmtNumber(tileCount(tiles, stage.key))}
                </span>
                <span className="text-[12px] font-medium leading-tight text-muted-foreground">{stage.label}</span>
              </Link>
              {i < RAIL.length - 1 && (
                <IconChevron width={18} height={18} className="shrink-0 text-muted-foreground/60" />
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
