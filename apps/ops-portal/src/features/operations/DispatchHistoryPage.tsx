import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import {
  getReport,
  reportRowShptId,
  getBankMasters,
  type BankMasterRow,
  type ReportCell,
  type ReportFilters,
  type ReportRow,
} from '../../api/endpoints.js'
import { WatermarkBadge } from '../../components/WatermarkBadge.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { Card, CardHeader, Field, Input, Select, Button, ErrorNote, SkeletonRows } from '../../ui/primitives.js'
import { humanHeader } from '../../ui/format.js'
import { COURIER_STATUSES } from '../dashboards/courierStatuses.js'

// Dispatch history (Phase 7 Task 9). REUSES the existing
// getReport('soundbox-delivery', filters) endpoint (the Soundbox Delivery
// Report IS the dispatch_row list): no new route is added here. Filter
// inputs mirror ReportPage's shape (from/to/bank/status).
//
// G-SHPT (docs/plan/phase7_grounding/G_SHPT_backend_spec.md): the backend
// slice (commit 354aa76) added `shptId: r.shpt_id` to this exact report's
// rows (services/analytics/src/mediation.ts soundboxDeliveryRow) - already a
// wire `shpt_...` string end to end, no re-encoding needed. This is what
// makes a "Correct status" action possible here: an operator picks a REAL
// row to drive StatusCorrectionForm's shptId, rather than hand-typing one.
// A row with a null shptId (no shipment fact folded yet for that dispatch)
// has its action permanently disabled - it must never become correctable
// via a fabricated or looked-up-elsewhere id.
//
// Phase 7 Task 10 adds a second row action, "Override" (Terminal Override,
// the step-up-gated counterpart in ../destructive/TerminalOverrideForm.tsx),
// gated by the exact same real-shptId guard as "Correct status" - a row
// without a verified wire shptId must not be overridable either.

function cellText(cell: ReportCell | undefined): string {
  const value = cell ?? null
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return value.join('; ')
  return String(value)
}

const GATED_TITLE = 'No verified wire shipment id for this row yet; status correction is unavailable.'
const GATED_OVERRIDE_TITLE = 'No verified wire shipment id for this row yet; terminal override is unavailable.'

// Columns are the union of every row's keys, in first-seen order, plus one
// synthetic Actions column: the soundbox-delivery report's own column set is
// fixed at the backend, so this renders whatever it actually returns rather
// than a column list invented here (mirrors ReportPage's buildColumns).
function buildColumns(
  rows: ReportRow[],
  onCorrectStatus: (row: ReportRow) => void,
  onOverrideTerminal: (row: ReportRow) => void,
): DataTableColumn<ReportRow>[] {
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
  // Same transform ReportPage uses. This read `dispatchId  programId
  // bankCode  merchantDisplay` before, which is our field names on the
  // operator's screen.
  const dataColumns = keys.map((key) => ({ key, header: humanHeader(key), cell: (row: ReportRow) => cellText(row[key]) }))
  const actionsColumn: DataTableColumn<ReportRow> = {
    key: '__actions',
    header: 'Actions',
    cell: (row: ReportRow) => {
      const shptId = reportRowShptId(row)
      return (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={shptId === null}
            title={shptId === null ? GATED_TITLE : undefined}
            onClick={() => onCorrectStatus(row)}
          >
            Correct status
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={shptId === null}
            title={shptId === null ? GATED_OVERRIDE_TITLE : undefined}
            onClick={() => onOverrideTerminal(row)}
          >
            Override
          </Button>
        </div>
      )
    },
  }
  return [...dataColumns, actionsColumn]
}

export interface DispatchHistoryPageProps {
  onCorrectStatus: (row: ReportRow) => void
  onOverrideTerminal: (row: ReportRow) => void
}

export function DispatchHistoryPage({ onCorrectStatus, onOverrideTerminal }: DispatchHistoryPageProps) {
  const { client } = useAuth()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [bank, setBank] = useState('')
  const [status, setStatus] = useState('')
  const [rows, setRows] = useState<ReportRow[]>([])
  // The real bank list, so Bank is a choice rather than a spelling test.
  const [banks, setBanks] = useState<BankMasterRow[]>([])
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

  // Loaded separately from the history itself, and deliberately silent on
  // failure: a bank list that does not arrive must not stop the rows
  // rendering, it just leaves the filter holding only "Any bank". Mirrors
  // ReportPage, which does the same for the same reason.
  useEffect(() => {
    let cancelled = false
    getBankMasters(client)
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setBanks(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <Card>
      <CardHeader title="Dispatch history" actions={<WatermarkBadge watermark={watermark} />} />

      <div className="flex flex-wrap items-end gap-4 px-5 pt-4">
        <Field label="From" htmlFor="dispatch-from">
          <Input id="dispatch-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="dispatch-to">
          <Input id="dispatch-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {/* Both cover a KNOWN value set, so both are pickers, exactly as
            redesign step 5 already made them on Reports. As free text they were
            the typed-id problem: get the string exactly right or silently get
            nothing back, with no way to tell a real empty result from a typo.
            The bank option's VALUE is the reference code the edge filters on;
            its LABEL is the name a human uses. */}
        <Field label="Bank" htmlFor="dispatch-bank">
          <Select id="dispatch-bank" value={bank} onChange={(e) => setBank(e.target.value)}>
            <option value="">Any bank</option>
            {banks.map((b) => (
              <option key={b.tnntId} value={b.bankReferenceCode}>
                {b.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" htmlFor="dispatch-status">
          <Select id="dispatch-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            {COURIER_STATUSES.map((cs) => (
              <option key={cs} value={cs}>
                {cs}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          onClick={() => {
            void load()
          }}
        >
          Search
        </Button>
      </div>

      {error !== null && (
        <div className="px-5 pt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="p-5">
        {loading ? (
          <SkeletonRows rows={6} cols={5} />
        ) : (
          <DataTable
            columns={buildColumns(rows, onCorrectStatus, onOverrideTerminal)}
            rows={rows}
            emptyMessage="No dispatch history for the current filters."
          />
        )}
      </div>
    </Card>
  )
}
