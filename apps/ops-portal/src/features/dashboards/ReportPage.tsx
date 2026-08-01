import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getReport,
  getReportCsv,
  getTileDrilldown,
  getTileDrilldownCsv,
  type ReportCell,
  type ReportFilters,
  type ReportName,
  type ReportRow,
  type TileName,
} from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { downloadCsv } from './exportCsv.js'

// The six FR-10 reports. The Activation Report renders as the
// delivered-not-activated worklist (services/analytics/src/mediation.ts's
// activationRow): a real worklist of delivered dispatches, whose activation
// columns render null until FR-07 lands a write path. That is a faithful
// null, not a fabricated tile count, so it is rendered like any other cell.
const REPORT_DEFS: ReadonlyArray<{ value: ReportName; label: string }> = [
  { value: 'soundbox-delivery', label: 'Soundbox delivery' },
  { value: 'activation', label: 'Activation (delivered, not activated worklist)' },
  { value: 'damaged-replacement', label: 'Damaged / replacement' },
  { value: 'print-vendor-pendency', label: 'Print vendor pendency' },
  { value: 'courier-pendency', label: 'Courier pendency' },
  { value: 'batching', label: 'Batching' },
]

const TILE_DEFS: ReadonlyArray<{ value: TileName; label: string }> = [
  { value: 'requestsReceived', label: 'Requests received' },
  { value: 'pendingQrAwaitingBatch', label: 'Pending QR, awaiting batch' },
  { value: 'pendingPrintVendorPickup', label: 'Pending print vendor pickup' },
  { value: 'dispatchedNotDelivered', label: 'Dispatched, not delivered' },
  { value: 'deliveredNotActivated', label: 'Delivered, not activated' },
  { value: 'damagedReplacementOpen', label: 'Damaged, replacement open' },
  { value: 'activatedSuccessfully', label: 'Activated successfully' },
]

function isTileName(value: string | null): value is TileName {
  return value !== null && TILE_DEFS.some((d) => d.value === value)
}

function cellText(cell: ReportCell | undefined): string {
  const value = cell ?? null
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.join('; ')
  return String(value)
}

// Columns are the union of every row's keys, in first-seen order: the six
// reports (and the seven drilldowns) each have a different, fixed column set
// per call, so this renders whatever the backend actually returned rather
// than a column list invented here (mirrors services/analytics/src/export.ts
// toCsv's own column derivation).
function buildColumns(rows: ReportRow[]): DataTableColumn<ReportRow>[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  return keys.map((key) => ({ key, header: key, cell: (row: ReportRow) => cellText(row[key]) }))
}

export function ReportPage() {
  const { client } = useAuth()
  const [searchParams] = useSearchParams()
  const tileParam = searchParams.get('tile')
  const initialTile = isTileName(tileParam) ? tileParam : null

  const [mode, setMode] = useState<'report' | 'drilldown'>(initialTile !== null ? 'drilldown' : 'report')
  const [reportName, setReportName] = useState<ReportName>('soundbox-delivery')
  const [tileName, setTileName] = useState<TileName>(initialTile ?? 'requestsReceived')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [bank, setBank] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<ReportRow[]>([])
  const [watermark, setWatermark] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function currentFilters(): ReportFilters {
    const filters: ReportFilters = {}
    if (from !== '') filters.from = from
    if (to !== '') filters.to = to
    if (bank !== '') filters.bank = bank
    if (status !== '') filters.status = status
    return filters
  }

  async function load(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const result =
        mode === 'report'
          ? await getReport(client, reportName, currentFilters())
          : await getTileDrilldown(client, tileName, currentFilters())
      setRows(result.rows)
      setWatermark(result.watermark.asOf)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the report.')
    } finally {
      setLoading(false)
    }
  }

  // Initial load only, for whatever mode/name the route landed on (including
  // a tile drilldown navigated in from TilesPage via ?tile=). The Search
  // button drives every subsequent fetch so a request is never fired on
  // every keystroke into the filter inputs.
  useEffect(() => {
    void load()
  }, [])

  async function handleExport(): Promise<void> {
    const csv =
      mode === 'report'
        ? await getReportCsv(client, reportName, currentFilters())
        : await getTileDrilldownCsv(client, tileName, currentFilters())
    const filename = `${mode === 'report' ? reportName : tileName}.csv`
    downloadCsv(filename, csv)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Reports</h1>
        <WatermarkBadge watermark={watermark} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="report-mode">
            View
          </label>
          <select
            id="report-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value === 'drilldown' ? 'drilldown' : 'report')}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="report">Report</option>
            <option value="drilldown">Tile drilldown</option>
          </select>
        </div>

        {mode === 'report' ? (
          <div>
            <label className="block text-xs font-medium text-slate-600" htmlFor="report-name">
              Report
            </label>
            <select
              id="report-name"
              value={reportName}
              onChange={(e) => setReportName(e.target.value as ReportName)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {REPORT_DEFS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div>
            <label className="block text-xs font-medium text-slate-600" htmlFor="tile-name">
              Tile
            </label>
            <select
              id="tile-name"
              value={tileName}
              onChange={(e) => setTileName(e.target.value as TileName)}
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            >
              {TILE_DEFS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="filter-from">
            From
          </label>
          <input
            id="filter-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="filter-to">
            To
          </label>
          <input
            id="filter-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="filter-bank">
            Bank
          </label>
          <input
            id="filter-bank"
            type="text"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor="filter-status">
            Status
          </label>
          <input
            id="filter-status"
            type="text"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
        </div>

        <button
          type="button"
          onClick={() => {
            void load()
          }}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Search
        </button>
        <button
          type="button"
          onClick={() => {
            void handleExport()
          }}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Export CSV
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}

      <DataTable columns={buildColumns(rows)} rows={rows} emptyMessage="No rows for the current filters." />
    </div>
  )
}
