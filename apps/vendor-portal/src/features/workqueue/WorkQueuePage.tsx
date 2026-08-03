import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { workQueue } from '../../api/endpoints.js'
import { ApiError } from '../../api/errors.js'
import type { WorkQueueRow } from '../../api/types.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'

// Vendor work queue (spec 14b task 12). Reads GET /vendor/work-queue via the
// existing workQueue(client) endpoint (task 10). PII-free by construction:
// the backend row (WorkQueueRow) carries no ship-to or contact fields, so
// this page renders exactly its columns and adds nothing.

const COLUMNS: ReadonlyArray<DataTableColumn<WorkQueueRow>> = [
  { key: 'btchId', header: 'Batch', cell: (row) => row.btchId },
  { key: 'unitCount', header: 'Units', cell: (row) => row.unitCount },
  { key: 'status', header: 'Status', cell: (row) => row.status },
  { key: 'openEntries', header: 'Open entries', cell: (row) => row.openEntries },
  { key: 'createdAt', header: 'Created', cell: (row) => row.createdAt },
]

export function WorkQueuePage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<WorkQueueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      try {
        const result = await workQueue(client)
        if (!cancelled) setRows(result)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? `Failed to load the work queue (${err.status}).` : 'Failed to load the work queue.')
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
      <h2 className="text-sm font-semibold text-slate-800">Work queue</h2>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-500">Loading...</p>}

      <DataTable columns={COLUMNS} rows={rows} getRowKey={(row) => row.btchId} emptyMessage="No batches in the work queue." />
    </div>
  )
}
