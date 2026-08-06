import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getTiles, type TileName, type TileSet } from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { PageHeader, Card, ErrorNote } from '../../ui/primitives.js'
import type { ComponentType, SVGProps } from 'react'
import {
  IconChevron,
  IconUploads,
  IconQueues,
  IconOperations,
  IconArrowUpDown,
  IconAlert,
  IconCheck,
} from '../../ui/icons.js'
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

// The tone vocabulary is the SAME status language the pills use (index.css
// .pill-*), so a stage that reads "waiting" on a table row reads "waiting" on a
// tile too. Tiles previously rendered as seven near-identical white rectangles,
// which gave the eye nothing to land on.
type Tone = 'pending' | 'info' | 'positive' | 'negative' | 'neutral'

const TONE_CHIP: Record<Tone, string> = {
  pending: 'bg-[#fbeed5] text-[#a15c07]',
  info: 'bg-[#e6edfe] text-[#1d4ed8]',
  positive: 'bg-[#e2f3ea] text-[#15803d]',
  negative: 'bg-[#fbe9e9] text-[#b91c1c]',
  neutral: 'bg-surface-2 text-subtle',
}

interface TileDef {
  key: TileName
  label: string
  hint: string
  tone: Tone
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

// Ordered so LIVE numbers lead and the two activation-empty tiles sit last
// together. They previously interrupted the run of real counts, which put dead
// space in the middle of the most-scanned row.
const TILE_DEFS: readonly TileDef[] = [
  { key: 'requestsReceived', label: 'Requests received', hint: 'Bank requests ingested', tone: 'info', icon: IconUploads },
  { key: 'pendingQrAwaitingBatch', label: 'Pending QR, awaiting batch', hint: 'Received or pooled', tone: 'pending', icon: IconQueues },
  { key: 'pendingPrintVendorPickup', label: 'Pending print vendor pickup', hint: 'Sent to print vendor', tone: 'pending', icon: IconOperations },
  { key: 'dispatchedNotDelivered', label: 'Dispatched, not delivered', hint: 'Awaiting delivery', tone: 'info', icon: IconArrowUpDown },
  { key: 'damagedReplacementOpen', label: 'Damaged, replacement open', hint: 'Open replacement cases', tone: 'negative', icon: IconAlert },
  { key: 'deliveredNotActivated', label: 'Delivered, not activated', hint: 'Awaiting activation', tone: 'neutral', icon: IconCheck },
  { key: 'activatedSuccessfully', label: 'Activated successfully', hint: 'Live in the field', tone: 'positive', icon: IconCheck },
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
  const Icon = def.icon
  const emphasized = def.key === EMPHASIZED_TILE
  const isActivationEmpty = ACTIVATION_EMPTY_TILES.has(def.key)
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
      <div className="flex items-start justify-between gap-3">
        <p className={emphasized ? 'text-[13px] font-medium text-brand-contrast/80' : 'text-[13px] font-medium text-muted-foreground'}>
          {def.label}
        </p>
        {/* A tinted icon chip carries the stage's tone, so the grid is scannable
            by colour before any number is read. The chevron still appears on
            hover to signal the drill-down. */}
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${
            emphasized ? 'bg-brand-contrast/15 text-brand-contrast' : TONE_CHIP[def.tone]
          }`}
        >
          <Icon width={15} height={15} />
        </span>
      </div>
      <div className="mt-3">
        {/* The activation-empty marker is prose, not a measurement, so it must
            not borrow the numeral treatment: at 30px mono it wrapped to three
            lines and read louder than the real counts beside it. It renders as
            quiet body text at the same optical position instead. */}
        {isActivationEmpty ? (
          <p
            className={
              emphasized
                ? 'text-[15px] leading-tight text-brand-contrast/70'
                : 'text-[15px] leading-tight text-subtle'
            }
          >
            {ACTIVATION_EMPTY_MARKER}
          </p>
        ) : (
          <p
            className={
              emphasized
                ? 'num text-[30px] font-semibold leading-none tracking-[-0.02em]'
                : 'num text-[30px] font-semibold leading-none tracking-[-0.02em] text-ink'
            }
          >
            {tileDisplay(tiles, def.key)}
          </p>
        )}
        <p
          className={
            emphasized
              ? 'mt-2 flex items-center gap-1 text-[12px] text-brand-contrast/70'
              : 'mt-2 flex items-center gap-1 text-[12px] text-subtle'
          }
        >
          {oldest !== null ? `Oldest ${fmtDays(oldest)} in queue` : def.hint}
          <IconChevron
            width={13}
            height={13}
            className={
              emphasized
                ? 'text-brand-contrast/70'
                : 'text-subtle opacity-0 transition-opacity group-hover:opacity-100'
            }
          />
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
                <span className="mt-2 text-[12px] font-medium text-muted-foreground">{stage.label}</span>
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
      {/* The dashboard is where an operator starts their day, so it offers the
          action they came to take. Ingesting a bank file is the head of the
          whole pipeline: everything else on this page is downstream of it. */}
      <PageHeader
        title="Dashboards"
        description="Live snapshot of the soundbox dispatch pipeline across all programs."
        actions={
          <>
            <WatermarkBadge watermark={watermark} />
            <Link
              to="/uploads"
              className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/80"
            >
              <IconUploads width={16} height={16} />
              Upload bank file
            </Link>
          </>
        }
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
