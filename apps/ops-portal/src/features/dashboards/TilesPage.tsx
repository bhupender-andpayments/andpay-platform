import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getTiles, type TileName, type TileSet } from '../../api/endpoints.js'
import { PageHeader, Card, ErrorNote } from '../../ui/primitives.js'
import { IconChevron } from '../../ui/icons.js'
import { fmtDateTime, fmtNumber, type PillVariant } from '../../ui/format.js'

// Demo skin dashboard (Task 8). The 7 FR-09 tiles render the real seeded
// values (the spine's ACTIVATION-EMPTY masking is dropped: the demo seed has a
// real activation write, so `deliveredNotActivated` and `activatedSuccessfully`
// are meaningful and shown). Each tile drills into its filtered list. The
// signature lifecycle rail summarizes the dispatch funnel at a glance.

interface TileDef {
  key: TileName
  label: string
  hint: string
  variant: PillVariant
}
const TILE_DEFS: readonly TileDef[] = [
  { key: 'requestsReceived', label: 'Requests received', hint: 'Bank requests ingested', variant: 'neutral' },
  { key: 'pendingQrAwaitingBatch', label: 'Pending QR, awaiting batch', hint: 'Received or pooled', variant: 'pending' },
  { key: 'pendingPrintVendorPickup', label: 'Pending vendor pickup', hint: 'Sent to print vendor', variant: 'info' },
  { key: 'dispatchedNotDelivered', label: 'Dispatched, in transit', hint: 'Awaiting delivery', variant: 'info' },
  { key: 'deliveredNotActivated', label: 'Delivered, not activated', hint: 'Awaiting activation', variant: 'pending' },
  { key: 'damagedReplacementOpen', label: 'Damaged, replacement open', hint: 'Open replacement cases', variant: 'negative' },
  { key: 'activatedSuccessfully', label: 'Activated successfully', hint: 'Live in the field', variant: 'positive' },
]

const DOT: Record<PillVariant, string> = {
  neutral: 'bg-subtle',
  pending: 'bg-[#c07f16]',
  info: 'bg-[#1d4ed8]',
  positive: 'bg-[#15803d]',
  negative: 'bg-[#b91c1c]',
  brand: 'bg-brand',
}

function tileCount(tiles: TileSet, key: TileName): number {
  const v = tiles[key]
  return typeof v === 'number' ? v : v.count
}

// The signature funnel: the pending pipeline as a left-to-right rail. Each
// stage is a real tile value, so the operator reads the whole flow at a glance.
const RAIL: ReadonlyArray<{ label: string; key: TileName }> = [
  { label: 'Awaiting batch', key: 'pendingQrAwaitingBatch' },
  { label: 'Vendor pickup', key: 'pendingPrintVendorPickup' },
  { label: 'In transit', key: 'dispatchedNotDelivered' },
  { label: 'Not activated', key: 'deliveredNotActivated' },
  { label: 'Activated', key: 'activatedSuccessfully' },
]

function LifecycleRail({ tiles }: { tiles: TileSet }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">Dispatch pipeline</h2>
        <span className="text-[13px] text-muted">
          <span className="num text-ink">{fmtNumber(tiles.requestsReceived)}</span> requests received
        </span>
      </div>
      <div className="flex items-stretch gap-1 overflow-x-auto px-5 py-5">
        {RAIL.map((stage, i) => (
          <div key={stage.key} className="flex flex-1 items-center gap-1">
            <Link
              to={`/reports?tile=${stage.key}`}
              className="group flex flex-1 flex-col rounded-lg border border-line bg-surface-2/50 px-4 py-3 transition-colors hover:border-brand/40 hover:bg-brand-weak/40"
            >
              <span className="text-[26px] font-semibold leading-none text-ink num">{fmtNumber(tileCount(tiles, stage.key))}</span>
              <span className="mt-2 text-[12px] font-medium text-muted">{stage.label}</span>
            </Link>
            {i < RAIL.length - 1 && <IconChevron width={18} height={18} className="shrink-0 text-subtle/60" />}
          </div>
        ))}
      </div>
    </Card>
  )
}

function TileCard({ def, tiles }: { def: TileDef; tiles: TileSet }) {
  const count = tileCount(tiles, def.key)
  const oldest =
    def.key === 'pendingQrAwaitingBatch' && typeof tiles.pendingQrAwaitingBatch !== 'number'
      ? tiles.pendingQrAwaitingBatch.oldestAgeDays
      : null
  return (
    <Link
      to={`/reports?tile=${def.key}`}
      className="group flex flex-col justify-between rounded-lg border border-line bg-surface p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${DOT[def.variant]}`} />
          <p className="text-[13px] font-medium text-muted">{def.label}</p>
        </div>
        <IconChevron width={16} height={16} className="text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-3">
        <p className="num text-[30px] font-semibold leading-none tracking-[-0.02em] text-ink">{fmtNumber(count)}</p>
        <p className="mt-2 text-[12px] text-subtle">
          {oldest !== null ? `Oldest ${Math.round(oldest)}d in queue` : def.hint}
        </p>
      </div>
    </Link>
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
        actions={
          watermark !== null ? (
            <span className="pill pill-neutral" title={watermark}>
              Updated {fmtDateTime(watermark)}
            </span>
          ) : undefined
        }
      />

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {tiles === null && error === null && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TILE_DEFS.map((d) => (
            <div key={d.key} className="skeleton h-28 rounded-lg" />
          ))}
        </div>
      )}

      {tiles !== null && (
        <>
          <LifecycleRail tiles={tiles} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {TILE_DEFS.map((def) => (
              <TileCard key={def.key} def={def} tiles={tiles} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
