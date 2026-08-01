import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { getTiles, type TileName, type TileSet } from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'

// FR-07 phase-1: no activation write path exists yet in live v1 data, so
// activation_status is always null (services/analytics/src/mediation.ts,
// activationRow's comment). That makes `deliveredNotActivated` equal the
// whole delivered set and `activatedSuccessfully` always zero: both are real
// numbers the backend can return, but neither reflects a meaningful
// activation state yet. These two tiles render a neutral marker instead of
// the backend value until FR-07 lands a real activation write path; every
// other tile renders the backend value faithfully.
const ACTIVATION_EMPTY_TILES: ReadonlySet<TileName> = new Set<TileName>([
  'deliveredNotActivated',
  'activatedSuccessfully',
])
const ACTIVATION_EMPTY_MARKER = 'Not available yet'

const TILE_DEFS: ReadonlyArray<{ key: TileName; label: string }> = [
  { key: 'requestsReceived', label: 'Requests received' },
  { key: 'pendingQrAwaitingBatch', label: 'Pending QR, awaiting batch' },
  { key: 'pendingPrintVendorPickup', label: 'Pending print vendor pickup' },
  { key: 'dispatchedNotDelivered', label: 'Dispatched, not delivered' },
  { key: 'deliveredNotActivated', label: 'Delivered, not activated' },
  { key: 'damagedReplacementOpen', label: 'Damaged, replacement open' },
  { key: 'activatedSuccessfully', label: 'Activated successfully' },
]

function tileDisplay(tiles: TileSet, key: TileName): string {
  if (ACTIVATION_EMPTY_TILES.has(key)) return ACTIVATION_EMPTY_MARKER
  const value = tiles[key]
  return typeof value === 'number' ? String(value) : String(value.count)
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Dashboards</h1>
        <WatermarkBadge watermark={watermark} />
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILE_DEFS.map((def) => (
          <Link
            key={def.key}
            to={`/reports?tile=${def.key}`}
            className="rounded border border-slate-200 bg-white p-4 hover:border-slate-300"
          >
            <p className="text-sm text-slate-500">{def.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {tiles === null ? '...' : tileDisplay(tiles, def.key)}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
