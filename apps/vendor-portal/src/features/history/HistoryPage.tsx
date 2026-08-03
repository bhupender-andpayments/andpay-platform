import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { history } from '../../api/endpoints.js'
import { ApiError } from '../../api/errors.js'
import type { HistoryRow } from '../../api/types.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'

// Vendor dispatch history (spec 14b task 12). Reads GET /vendor/history via
// the existing history(client) endpoint (task 10). PII-free by construction:
// the backend row (HistoryRow) carries no ship-to or contact fields, so this
// page renders exactly its columns and adds nothing. deviceSerial is
// nullable and rendered as a dash rather than the literal string "null".

const COLUMNS: ReadonlyArray<DataTableColumn<HistoryRow>> = [
  { key: 'btchId', header: 'Batch', cell: (row) => row.btchId },
  { key: 'awb', header: 'AWB', cell: (row) => row.awb },
  { key: 'shptStatus', header: 'Status', cell: (row) => row.shptStatus },
  { key: 'dispatchDate', header: 'Dispatch date', cell: (row) => row.dispatchDate },
  { key: 'deviceSerial', header: 'Device serial', cell: (row) => row.deviceSerial ?? '-' },
]

export function HistoryPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      try {
        const result = await history(client)
        if (!cancelled) setRows(result)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? `Failed to load the dispatch history (${err.status}).` : 'Failed to load the dispatch history.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-4 rounded border border-slate-200 p-4">
      <h2 className="text-sm font-semibold text-slate-800">Dispatch history</h2>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}

      <DataTable columns={COLUMNS} rows={rows} getRowKey={(row) => `${row.btchId}-${row.awb}`} emptyMessage="No dispatch history yet." />
    </div>
  )
}
