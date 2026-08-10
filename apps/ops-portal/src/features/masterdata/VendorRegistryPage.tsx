import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'
import { Card, CardHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'

// The full vendor registry (Phase 7 Task 8, spec 13 check 6): every vendor
// row the platform-only /ops/vendors read returns, regardless of type
// (MANUFACTURER | PRINT | COURIER). Read-only: vendor create and suspend are
// separate tasks (operations / destructive actions), not this view.

export const VENDOR_COLUMNS: ReadonlyArray<DataTableColumn<VendorRow>> = [
  { key: 'type', header: 'Type', cell: (r) => <CodeChip>{r.type}</CodeChip> },
  {
    key: 'displayName',
    header: 'Display name',
    cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>,
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
  {
    key: 'courierCode',
    header: 'Courier code',
    cell: (r) => (r.courierCode ? <CodeChip>{r.courierCode}</CodeChip> : <span className="text-muted-foreground">-</span>),
  },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
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
        // `res` is TYPED VendorRow[], but the type is an assertion about a
        // fetch body and not a check of it. A failed read arrives here as an
        // error envelope, and the subtitle below then prints "undefined
        // vendors". Say what happened; the value still goes into state so
        // DataTable can refuse to render it as an empty list.
        if (!Array.isArray(res)) setError('Unexpected response shape.')
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
        <CardHeader title="Vendor registry" subtitle={Array.isArray(rows) ? `${rows.length} vendors` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={5} cols={6} />
        ) : (
          <DataTable columns={VENDOR_COLUMNS} rows={rows} getRowKey={(r) => r.id} emptyMessage="No vendors." />
        )}
      </Card>
    </div>
  )
}
