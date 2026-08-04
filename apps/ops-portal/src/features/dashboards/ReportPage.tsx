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
import { PageHeader, Card, CardHeader, Field, Select, Input, Button, ErrorNote, SkeletonRows } from '../../ui/primitives.js'
import { IconSearch, IconDownload } from '../../ui/icons.js'

// The six FR-10 reports plus the seven tile drilldowns (Task 9). Server-side
// filters (date window, bank, courier status); the results render on the shared
// token-styled table. The Activation report is the delivered-not-activated
// worklist; its activation columns are faithful nulls, never fabricated.
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

// Humane column headers for the raw backend keys; unknown keys fall back to the
// key itself. Numeric-ish columns are right-aligned and rendered mono.
const NUMERIC_KEYS = new Set(['ageingDays', 'count', 'standeeCount', 'stickerCount', 'rowNo'])
function humanHeader(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

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
  return keys.map((key) => ({
    key,
    header: humanHeader(key),
    align: NUMERIC_KEYS.has(key) ? ('right' as const) : ('left' as const),
    cell: (row: ReportRow) => {
      const text = cellText(row[key])
      if (text === '') return <span className="text-subtle">-</span>
      return <span className={NUMERIC_KEYS.has(key) ? 'num' : undefined}>{text}</span>
    },
  }))
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
  const [loading, setLoading] = useState(true)
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

  // Initial load only. The Search button drives every subsequent fetch so a
  // request is never fired on every keystroke into a filter input.
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

  const activeLabel =
    mode === 'report'
      ? REPORT_DEFS.find((d) => d.value === reportName)?.label
      : TILE_DEFS.find((d) => d.value === tileName)?.label

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Operational reports and tile drill-downs across all programs."
        actions={<WatermarkBadge watermark={watermark} />}
      />

      <Card>
        <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="View" htmlFor="report-mode">
            <Select id="report-mode" value={mode} onChange={(e) => setMode(e.target.value === 'drilldown' ? 'drilldown' : 'report')}>
              <option value="report">Report</option>
              <option value="drilldown">Tile drilldown</option>
            </Select>
          </Field>
          {mode === 'report' ? (
            <Field label="Report" htmlFor="report-name">
              <Select id="report-name" value={reportName} onChange={(e) => setReportName(e.target.value as ReportName)}>
                {REPORT_DEFS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Tile" htmlFor="tile-name">
              <Select id="tile-name" value={tileName} onChange={(e) => setTileName(e.target.value as TileName)}>
                {TILE_DEFS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="From" htmlFor="filter-from">
            <Input id="filter-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="filter-to">
            <Input id="filter-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Bank" htmlFor="filter-bank">
            <Input id="filter-bank" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="e.g. HDFC" />
          </Field>
          <Field label="Status" htmlFor="filter-status">
            <Input id="filter-status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="e.g. DELIVERED" />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="secondary" onClick={() => { void handleExport() }}>
            <IconDownload width={16} height={16} />
            Export CSV
          </Button>
          <Button onClick={() => { void load() }}>
            <IconSearch width={16} height={16} />
            Search
          </Button>
        </div>
      </Card>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardHeader title={activeLabel ?? 'Results'} subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`} />
        {loading ? (
          <SkeletonRows rows={6} cols={6} />
        ) : (
          <DataTable columns={buildColumns(rows)} rows={rows} emptyMessage="No rows for the current filters." />
        )}
      </Card>
    </div>
  )
}
