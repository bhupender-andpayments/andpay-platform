import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'

// The full vendor registry (Task 12, spec 13 check 6): every vendor row the
// platform-only /ops/vendors read returns, regardless of type
// (MANUFACTURER | PRINT | COURIER). Read-only: vendor create and suspend are
// Tasks 14/15, not this view.

function orDash(value: string | null): string {
  return value ?? '-'
}

export const VENDOR_COLUMNS: ReadonlyArray<DataTableColumn<VendorRow>> = [
  { key: 'type', header: 'Type', cell: (r) => r.type },
  { key: 'displayName', header: 'Display name', cell: (r) => r.displayName },
  { key: 'status', header: 'Status', cell: (r) => r.status },
  { key: 'courierCode', header: 'Courier code', cell: (r) => orDash(r.courierCode) },
  { key: 'createdAt', header: 'Created', cell: (r) => r.createdAt },
  { key: 'updatedAt', header: 'Updated', cell: (r) => r.updatedAt },
]

export function VendorRegistryPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        setRows(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load vendors.')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Vendor Registry</h1>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <DataTable columns={VENDOR_COLUMNS} rows={rows} getRowKey={(r) => r.id} emptyMessage="No vendors." />
    </div>
  )
}
