import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { workQueue } from '../../api/endpoints.js'
import { ApiError } from '../../api/errors.js'
import type { WorkQueueRow } from '../../api/types.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { DownloadPackageButton } from '../pull/DownloadPackageButton.js'

// Vendor work queue (spec 14b task 12). Reads GET /vendor/work-queue via the
// existing workQueue(client) endpoint (task 10). PII-free by construction:
// the backend row (WorkQueueRow) carries no ship-to or contact fields, so
// this page renders exactly its columns and adds nothing. The Package
// column (task 15) wires in the standalone DownloadPackageButton (task 13)
// per row, passing only row.btchId: the button stays PII-free too, and the
// FR-04 pull's own vndr/authorization check happens solely at the edge.
//
// 2026-08-10 ruling: the pull is per DELIVERY GROUP, same as the dispatch
// Excel builder and the ops download, so the Package column now renders TWO
// buttons per row rather than one, each carrying its own group and label.
//
// D-12 (Q11 ruled 13 Aug 2026): a dispatch is FOUR files, in two pairs, an
// Excel plus its QR images per group. This column only ever offered the two
// Excels, and its own labels said so, while the images route sat live and
// authorized at the edge with nothing calling it. So a print vendor could click
// their way to half their package and had to hand-build a URL for the other
// half, which is exactly the sort of thing that gets done once and then done
// wrong. Four buttons now, grouped in the two pairs the ruling names, so the
// column reads the way the package is actually shaped.
const COLUMNS: ReadonlyArray<DataTableColumn<WorkQueueRow>> = [
  { key: 'btchId', header: 'Batch', cell: (row) => row.btchId },
  { key: 'unitCount', header: 'Units', cell: (row) => row.unitCount },
  { key: 'openEntries', header: 'Open entries', cell: (row) => row.openEntries },
  { key: 'createdAt', header: 'Created', cell: (row) => row.createdAt },
  {
    key: 'package',
    header: 'Package',
    cell: (row) => (
      <div className="space-y-3">
        <div className="space-y-2">
          <DownloadPackageButton btchId={row.btchId} group="SOUNDBOX" kind="excel" label="Soundbox Excel" />
          <DownloadPackageButton btchId={row.btchId} group="SOUNDBOX" kind="images" label="Soundbox QR images" />
        </div>
        <div className="space-y-2">
          <DownloadPackageButton btchId={row.btchId} group="COLLATERAL" kind="excel" label="Collateral Excel" />
          <DownloadPackageButton btchId={row.btchId} group="COLLATERAL" kind="images" label="Collateral QR images" />
        </div>
      </div>
    ),
  },
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
