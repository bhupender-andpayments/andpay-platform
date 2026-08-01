import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'

// The courier master (Task 12, spec 13 check 6). Per the grounded
// confirmation there is NO separate /ops/couriers route: the courier master
// is the vendor registry subset, filtered CLIENT-SIDE to type === 'COURIER'.
// Rows of type MANUFACTURER or PRINT must never appear here. Read-only:
// vendor create and suspend are Tasks 14/15, not this view.

function orDash(value: string | null): string {
  return value ?? '-'
}

const COURIER_COLUMNS: ReadonlyArray<DataTableColumn<VendorRow>> = [
  { key: 'courierCode', header: 'Courier code', cell: (r) => orDash(r.courierCode) },
  { key: 'displayName', header: 'Display name', cell: (r) => r.displayName },
  { key: 'status', header: 'Status', cell: (r) => r.status },
  { key: 'createdAt', header: 'Created', cell: (r) => r.createdAt },
  { key: 'updatedAt', header: 'Updated', cell: (r) => r.updatedAt },
]

export function CourierMasterPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        setRows(res.filter((r) => r.type === 'COURIER'))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load the courier master.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Courier Master</h1>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <DataTable columns={COURIER_COLUMNS} rows={rows} getRowKey={(r) => r.id} emptyMessage="No couriers." />
    </div>
  )
}
