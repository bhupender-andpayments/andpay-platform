import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { getReport, type ReportCell, type ReportFilters, type ReportRow } from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'

// Dispatch history (spec 13 task 14, check 6). REUSES the existing
// getReport('soundbox-delivery', filters) endpoint from Task 10 (the
// Soundbox Delivery Report IS the dispatch_row list): no new route is added
// here. Filter inputs mirror ReportPage's shape (from/to/bank/status).

function cellText(cell: ReportCell | undefined): string {
  const value = cell ?? null
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.join('; ')
  return String(value)
}

// Columns are the union of every row's keys, in first-seen order: the
// soundbox-delivery report's own column set is fixed at the backend, so this
// renders whatever it actually returns rather than a column list invented
// here (mirrors ReportPage's buildColumns, Task 10).
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

export function DispatchHistoryPage() {
  const { client } = useAuth()
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
      const result = await getReport(client, 'soundbox-delivery', currentFilters())
      setRows(result.rows)
      setWatermark(result.watermark.asOf)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the dispatch history.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Dispatch history</h2>
        <WatermarkBadge watermark={watermark} />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="dispatch-from">
            From
          </label>
          <input
            id="dispatch-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="dispatch-to">
            To
          </label>
          <input
            id="dispatch-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="dispatch-bank">
            Bank
          </label>
          <input
            id="dispatch-bank"
            type="text"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <div>
          <label className="mb-1 block text-[13px] font-medium text-ink" htmlFor="dispatch-status">
            Status
          </label>
          <input
            id="dispatch-status"
            type="text"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            void load()
          }}
          className="inline-flex h-10 items-center justify-center gap-2 rounded bg-brand px-4 text-sm font-medium text-brand-contrast shadow-sm hover:bg-brand-strong"
        >
          Search
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="rounded border border-[#f1c9c9] bg-[#fdf1f1] px-3.5 py-2.5 text-[13px] text-[#a11616]">
          {error}
        </p>
      )}
      {loading && <p className="text-[13px] text-subtle">Loading...</p>}

      <DataTable columns={buildColumns(rows)} rows={rows} emptyMessage="No dispatch history for the current filters." />
    </div>
  )
}
