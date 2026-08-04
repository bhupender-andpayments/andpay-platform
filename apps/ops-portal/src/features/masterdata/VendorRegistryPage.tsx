import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'
import { Card, CardHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'

// The full vendor registry: every vendor row the platform-only /ops/vendors
// read returns, regardless of type (MANUFACTURER | PRINT | COURIER). Read-only.

export const VENDOR_COLUMNS: ReadonlyArray<DataTableColumn<VendorRow>> = [
  { key: 'type', header: 'Type', cell: (r) => <CodeChip>{r.type}</CodeChip> },
  { key: 'displayName', header: 'Display name', cell: (r) => <span className="font-medium text-ink">{r.displayName}</span> },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
  { key: 'courierCode', header: 'Courier code', cell: (r) => (r.courierCode ? <CodeChip>{r.courierCode}</CodeChip> : <span className="text-subtle">-</span>) },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted">{fmtDate(r.updatedAt)}</span> },
]

export function VendorRegistryPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[] | null>(null)
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
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader title="Vendor registry" subtitle={rows !== null ? `${rows.length} vendors` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={5} cols={6} />
        ) : (
          <DataTable columns={VENDOR_COLUMNS} rows={rows} getRowKey={(r) => r.id} emptyMessage="No vendors." />
        )}
      </Card>
    </div>
  )
}
