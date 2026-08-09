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
  getBankMasters,
  type BankMasterRow,
} from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { downloadCsv } from './exportCsv.js'
import { PageHeader, Card, CardHeader, Field, Select, Input, Button, ErrorNote, SkeletonRows } from '../../ui/primitives.js'
import { IconSearch, IconDownload } from '../../ui/icons.js'
import { humanHeader } from '../../ui/format.js'
import { COURIER_STATUSES } from './courierStatuses.js'

// The six FR-10 reports. The Activation Report renders as the
// delivered-not-activated worklist (services/analytics/src/mediation.ts's
// activationRow): a real worklist of delivered dispatches, whose activation
// columns (activationStatus, simActivationStatus, activationDate,
// activationFailureReason) render null until FR-07 lands a write path (C3
// fence). That is a faithful null, not a fabricated value, so it is rendered
// like any other cell. Note there is no distinct SIM-serial-number column on
// this row: the only SIM-related field the endpoint returns is
// simActivationStatus (an activation-status mirror of the device, per
// project.ts's "device+SIM activate together on the single CWD confirmation"
// comment), not a SIM number; a real SIM serial lives in the fulfillment
// device-inventory domain and is not projected into this report (C4, no
// cross-context join) - see the task report for this documented gap.
// `hint` is NOT invented copy. It is only ever the parenthetical that already
// sat inside a label, lifted onto its own line now that a rail has room for two
// lines per item. The other five reports get no hint precisely because nothing
// in this codebase states what they contain, and guessing at a description an
// operator would then rely on is worse than showing the name alone.
const REPORT_DEFS: ReadonlyArray<{ value: ReportName; label: string; hint?: string }> = [
  { value: 'soundbox-delivery', label: 'Soundbox delivery' },
  { value: 'activation', label: 'Activation', hint: 'Delivered, not activated' },
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

// humanHeader moved to ui/format.ts when Dispatch History turned out to need
// the same transform: it was rendering raw backend keys as its headers.

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
  return keys.map((key) => ({
    key,
    header: humanHeader(key),
    cell: (row: ReportRow) => {
      const value = row[key]
      const text = cellText(value)
      if (text === '') return <span className="text-muted-foreground">-</span>
      // The `num` treatment (tabular monospace figures, so digits line up
      // column-wise) comes from the VALUE's type, not from a hard-coded key
      // list. The list it replaces happened to be complete on the day it was
      // written, which is exactly the failure mode: a numeric column added to
      // any of the 6 reports or 7 drilldowns afterwards would silently render
      // as ordinary prose figures and nobody would notice. buildColumns above
      // already derives columns from what the backend actually returned, for
      // the same reason, so this makes the two halves agree.
      //
      // The comment this replaces claimed `num` right-aligns. It does not:
      // index.css defines it as font-mono + tabular-nums + letter-spacing only.
      //
      // typeof, deliberately NOT a digits regex: a bank code, a pincode or an
      // id is digits that are not a QUANTITY, and aligning those as figures
      // reads as arithmetic the column does not support. The backend already
      // sends real numbers as numbers.
      return <span className={typeof value === 'number' ? 'num' : undefined}>{text}</span>
    },
  }))
}

export function ReportPage() {
  const { client } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const tileParam = searchParams.get('tile')
  const initialTile = isTileName(tileParam) ? tileParam : null

  // Step 5: the mode is DERIVED, never chosen. Command Center links in with
  // ?tile=<name> when an operator clicks a number, and they land on the rows
  // behind it. There is no reason for them to know that "report" and "tile
  // drilldown" are different things to us, so no control offers the choice.
  //
  // `tile` is STATE rather than a constant read of the URL for one reason: the
  // report rail has to be able to get you OUT of a drilldown. Picking a report
  // clears the tile (and the query param with it, so a reload agrees with the
  // screen). The operator still never picks a tile, which is the actual rule.
  //
  // There is deliberately NO derived `mode` variable. `tile === null` IS the
  // mode, and keeping a second name for it is how the two drift apart.
  const [tile, setTile] = useState<TileName | null>(initialTile)
  const [reportName, setReportName] = useState<ReportName>('soundbox-delivery')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [bank, setBank] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<ReportRow[]>([])
  const [watermark, setWatermark] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The real bank list, so Bank is a choice rather than a spelling test.
  const [banks, setBanks] = useState<BankMasterRow[]>([])

  function currentFilters(): ReportFilters {
    const filters: ReportFilters = {}
    if (from !== '') filters.from = from
    if (to !== '') filters.to = to
    if (bank !== '') filters.bank = bank
    if (status !== '') filters.status = status
    return filters
  }

  // `picked` is passed EXPLICITLY by the rail rather than read from state.
  // setReportName is asynchronous, so a rail click that called load() bare
  // would fetch the PREVIOUSLY selected report and the screen would trail one
  // click behind. Nothing else needs it, so it stays optional.
  async function load(picked?: { report: ReportName } | { tile: TileName }): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      let target: { report: ReportName } | { tile: TileName }
      if (picked !== undefined) {
        target = picked
      } else if (tile !== null) {
        target = { tile }
      } else {
        target = { report: reportName }
      }
      const result =
        'report' in target
          ? await getReport(client, target.report, currentFilters())
          : await getTileDrilldown(client, target.tile, currentFilters())
      setRows(result.rows)
      setWatermark(result.watermark.asOf)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the report.')
    } finally {
      setLoading(false)
    }
  }

  // Picking a report from the rail loads it straight away. A list you click is
  // a navigation, and making the operator then find a Search button to make
  // anything happen is the kind of dead click that teaches people the screen is
  // broken. The filters still wait for Search, because those DO come in sets.
  function selectReport(value: ReportName): void {
    setReportName(value)
    if (tile !== null) {
      setTile(null)
      // Drop ?tile= too, so a reload shows what the screen is showing.
      const next = new URLSearchParams(searchParams)
      next.delete('tile')
      setSearchParams(next, { replace: true })
    }
    void load({ report: value })
  }

  // Initial load only, for whatever mode/name the route landed on (including
  // a tile drilldown navigated in from TilesPage via ?tile=). The Search
  // button drives every subsequent fetch so a request is never fired on
  // every keystroke into the filter inputs.
  useEffect(() => {
    void load()
  }, [])

  // Loaded separately from the report itself: a bank list that fails to load
  // must not stop the report rendering, it just leaves the filter with only
  // "Any bank" in it.
  useEffect(() => {
    let cancelled = false
    getBankMasters(client)
      .then((rows) => {
        if (!cancelled && Array.isArray(rows)) setBanks(rows)
      })
      .catch(() => {
        // Deliberately silent: the report is the point of this screen, and a
        // missing filter is a smaller problem than an error banner over data
        // that loaded perfectly well.
      })
    return () => {
      cancelled = true
    }
  }, [client])

  // The export must never fail silently. This is called as `void handleExport()`
  // from the button, so without the catch a rejected request went nowhere: the
  // operator clicked Export CSV, no file arrived, and nothing said why. The
  // failure is reported through the SAME error surface the report load uses,
  // rather than a second one, so there is one place on this screen that says
  // something went wrong.
  async function handleExport(): Promise<void> {
    try {
      const csv =
        tile === null
          ? await getReportCsv(client, reportName, currentFilters())
          : await getTileDrilldownCsv(client, tile, currentFilters())
      const filename = `${tile === null ? reportName : tile}.csv`
      downloadCsv(filename, csv)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export this report.')
    }
  }

  const activeLabel =
    tile === null
      ? REPORT_DEFS.find((d) => d.value === reportName)?.label
      : TILE_DEFS.find((d) => d.value === tile)?.label

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Operational reports and tile drill-downs across all programs."
        actions={<WatermarkBadge watermark={watermark} />}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        {/* Step 5, finished. The report was chosen from a dropdown sitting in
            the filter row, which said that picking WHICH REPORT and setting a
            date range are the same kind of act. They are not: the report is the
            subject of the page and the filters narrow it.
            It also broke principle 4 outright, on the very screen the redesign
            named: six equal choices, one arbitrarily preselected and five
            hidden behind a closed control. A rail shows all six at once, which
            is the same reason the Uploads cards read well.
            The old dropdown carried a long comment about a two-column span and
            a 17px overlap. That has gone with it: a rail item is a full-width
            row, so nothing truncates and nothing can overlap a date input. */}
        <Card className="p-2">
          <nav aria-label="Reports" className="flex flex-col gap-1">
            {REPORT_DEFS.map((d) => {
              const active = tile === null && d.value === reportName
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => {
                    selectReport(d.value)
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-2xl px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <span className="block font-medium">{d.label}</span>
                  {d.hint !== undefined && (
                    <span className={`block text-xs ${active ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                      {d.hint}
                    </span>
                  )}
                </button>
              )
            })}
          </nav>
        </Card>

        {/* min-w-0 so a wide result table scrolls inside its own card instead of
            stretching this grid track and pushing the rail off screen. */}
        <div className="min-w-0 space-y-6">
          {tile !== null && (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    From Command Center
                  </p>
                  <p className="text-sm font-medium text-foreground">{activeLabel}</p>
                </div>
                <p className="text-sm text-muted-foreground">Choose a report on the left to leave this view.</p>
              </div>
            </Card>
          )}

          <Card>
            <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
              <Field label="From" htmlFor="filter-from">
                <Input id="filter-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To" htmlFor="filter-to">
                <Input id="filter-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              {/* Both filters cover a KNOWN value set, so both are pickers. As
                  free text they were the typed-id problem again: get the string
                  exactly right or silently get nothing back, with no way to tell
                  a real empty result from a typo. The bank option's VALUE is the
                  reference code the edge filters on; its LABEL is the name a
                  human uses. */}
              <Field label="Bank" htmlFor="filter-bank">
                <Select id="filter-bank" value={bank} onChange={(e) => setBank(e.target.value)}>
                  <option value="">Any bank</option>
                  {banks.map((b) => (
                    <option key={b.tnntId} value={b.bankReferenceCode}>
                      {b.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Status" htmlFor="filter-status">
                <Select id="filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">Any status</option>
                  {COURIER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
              <Button
                variant="secondary"
                onClick={() => {
                  void handleExport()
                }}
              >
                <IconDownload width={16} height={16} />
                Export CSV
              </Button>
              <Button
                onClick={() => {
                  void load()
                }}
              >
                <IconSearch width={16} height={16} />
                Search
              </Button>
            </div>
          </Card>

          {error !== null && <ErrorNote>{error}</ErrorNote>}

          <Card>
            <CardHeader
              title={activeLabel ?? 'Results'}
              subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
            />
            {loading ? (
              <SkeletonRows rows={6} cols={6} />
            ) : (
              <DataTable columns={buildColumns(rows)} rows={rows} emptyMessage="No rows for the current filters." />
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
