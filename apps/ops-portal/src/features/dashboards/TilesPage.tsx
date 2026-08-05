import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getTiles, type TileName, type TileSet } from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { PageHeader, Card, ErrorNote } from '../../ui/primitives.js'
import { IconChevron } from '../../ui/icons.js'
import { fmtNumber, fmtDays } from '../../ui/format.js'

// FR-09 dashboard tiles, reskinned onto the Task 1 design-system foundation
// and wired to the real analytics reads (GET /ops/reports/tiles + its
// per-tile drilldown). Every value below is read straight off the mocked/real
// TileSet response; nothing here invents a number.
//
// FR-07 phase-1: no activation write path exists yet in live v1 data, so
// activation_status is always null (services/analytics/src/mediation.ts,
// activationRow's comment). That makes `deliveredNotActivated` equal the
// whole delivered set and `activatedSuccessfully` always zero: both are real
// numbers the backend can return, but neither reflects a meaningful
// activation state yet. These two tiles render a neutral marker instead of
// the backend value until FR-07 lands a real activation write path (C3,
// fenced); every other tile renders the backend value faithfully.
const ACTIVATION_EMPTY_TILES: ReadonlySet<TileName> = new Set<TileName>([
  'deliveredNotActivated',
  'activatedSuccessfully',
])
const ACTIVATION_EMPTY_MARKER = 'Not available yet'

// The one emphasized tile (E design cue: "ONE tile emphasized with a filled
// accent; the rest neutral"). requestsReceived is the top-of-funnel volume
// metric and the natural headline number for an operator opening the
// dashboard; every other tile stays neutral. This is a presentation choice
// only, not a data choice: the value rendered is the same real aggregate as
// every other tile.
const EMPHASIZED_TILE: TileName = 'requestsReceived'

interface TileDef {
  key: TileName
  label: string
  hint: string
}

const TILE_DEFS: readonly TileDef[] = [
  { key: 'requestsReceived', label: 'Requests received', hint: 'Bank requests ingested' },
  { key: 'pendingQrAwaitingBatch', label: 'Pending QR, awaiting batch', hint: 'Received or pooled' },
  { key: 'pendingPrintVendorPickup', label: 'Pending print vendor pickup', hint: 'Sent to print vendor' },
  { key: 'dispatchedNotDelivered', label: 'Dispatched, not delivered', hint: 'Awaiting delivery' },
  { key: 'deliveredNotActivated', label: 'Delivered, not activated', hint: 'Awaiting activation' },
  { key: 'damagedReplacementOpen', label: 'Damaged, replacement open', hint: 'Open replacement cases' },
  { key: 'activatedSuccessfully', label: 'Activated successfully', hint: 'Live in the field' },
]

// The pending-pipeline funnel: a real-data-only lifecycle summary limited to
// the three stages that are actually meaningful in live v1 data (activation
// is fenced/empty, so it is deliberately left out of this rail; it still
// renders faithfully in the full tile grid above via ACTIVATION_EMPTY_TILES).
const RAIL: ReadonlyArray<{ label: string; key: TileName }> = [
  { label: 'Awaiting batch', key: 'pendingQrAwaitingBatch' },
  { label: 'Vendor pickup', key: 'pendingPrintVendorPickup' },
  { label: 'In transit', key: 'dispatchedNotDelivered' },
]

function tileCount(tiles: TileSet, key: TileName): number {
  const v = tiles[key]
  return typeof v === 'number' ? v : v.count
}

function tileDisplay(tiles: TileSet, key: TileName): string {
  if (ACTIVATION_EMPTY_TILES.has(key)) return ACTIVATION_EMPTY_MARKER
  return fmtNumber(tileCount(tiles, key))
}

function TileCard({ def, tiles }: { def: TileDef; tiles: TileSet }) {
  const emphasized = def.key === EMPHASIZED_TILE
  const oldest =
    def.key === 'pendingQrAwaitingBatch' && typeof tiles.pendingQrAwaitingBatch !== 'number'
      ? tiles.pendingQrAwaitingBatch.oldestAgeDays
      : null

  return (
    <Link
      to={`/reports?tile=${def.key}`}
      className={
        emphasized
          ? 'group flex flex-col justify-between rounded-lg bg-brand p-5 text-brand-contrast shadow-sm transition-all hover:-translate-y-0.5 hover:shadow'
          : 'group flex flex-col justify-between rounded-lg border border-line bg-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow'
      }
    >
      <div className="flex items-start justify-between">
        <p className={emphasized ? 'text-[13px] font-medium text-brand-contrast/80' : 'text-[13px] font-medium text-muted'}>
          {def.label}
        </p>
        <IconChevron
          width={16}
          height={16}
          className={
            emphasized
              ? 'text-brand-contrast/70'
              : 'text-subtle opacity-0 transition-opacity group-hover:opacity-100'
          }
        />
      </div>
      <div className="mt-3">
        <p
          className={
            emphasized
              ? 'num text-[30px] font-semibold leading-none tracking-[-0.02em]'
              : 'num text-[30px] font-semibold leading-none tracking-[-0.02em] text-ink'
          }
        >
          {tileDisplay(tiles, def.key)}
        </p>
        <p className={emphasized ? 'mt-2 text-[12px] text-brand-contrast/70' : 'mt-2 text-[12px] text-subtle'}>
          {oldest !== null ? `Oldest ${fmtDays(oldest)} in queue` : def.hint}
        </p>
      </div>
    </Link>
  )
}

function LifecycleRail({ tiles }: { tiles: TileSet }) {
  return (
    <div data-testid="lifecycle-rail">
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">Dispatch pipeline</h2>
        </div>
        <div className="flex items-stretch gap-1 overflow-x-auto px-5 py-5">
          {RAIL.map((stage, i) => (
            <div key={stage.key} className="flex flex-1 items-center gap-1">
              <Link
                to={`/reports?tile=${stage.key}`}
                className="group flex flex-1 flex-col rounded-lg border border-line bg-surface-2/50 px-4 py-3 transition-colors hover:border-brand/40 hover:bg-brand-weak/40"
              >
                <span className="num text-[26px] font-semibold leading-none text-ink">
                  {tileDisplay(tiles, stage.key)}
                </span>
                <span className="mt-2 text-[12px] font-medium text-muted">{stage.label}</span>
              </Link>
              {i < RAIL.length - 1 && <IconChevron width={18} height={18} className="shrink-0 text-subtle/60" />}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

export function TilesPage() {
  const { client } = useAuth()
  const [tiles, setTiles] = useState<TileSet | null>(null)
  const [watermark, setWatermark] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getTiles(client)
      .then((res) => {
        if (cancelled) return
        setTiles(res.tiles)
        setWatermark(res.watermark.asOf)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load tiles.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboards"
        description="Live snapshot of the soundbox dispatch pipeline across all programs."
        actions={<WatermarkBadge watermark={watermark} />}
      />

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {tiles === null && error === null && (
        <div
          data-testid="tile-grid-loading"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {TILE_DEFS.map((d) => (
            <div key={d.key} className="skeleton h-28 rounded-lg" />
          ))}
        </div>
      )}

      {tiles !== null && (
        <>
          <div data-testid="tile-grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {TILE_DEFS.map((def) => (
              <TileCard key={def.key} def={def} tiles={tiles} />
            ))}
          </div>
          <LifecycleRail tiles={tiles} />
        </>
      )}
    </div>
  )
}
