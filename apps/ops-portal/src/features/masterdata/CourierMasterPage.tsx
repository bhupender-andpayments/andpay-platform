import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'
import { Card, CardHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'

// The courier master (Phase 7 Task 8, spec 13 check 6). Per the grounded
// confirmation there is NO separate /ops/couriers route: the courier master
// is the vendor registry subset, filtered CLIENT-SIDE to type === 'COURIER'.
// Rows of type MANUFACTURER or PRINT must never appear here. Read-only.

const COURIER_COLUMNS: ReadonlyArray<DataTableColumn<VendorRow>> = [
  {
    key: 'courierCode',
    header: 'Courier code',
    cell: (r) => (r.courierCode ? <CodeChip>{r.courierCode}</CodeChip> : <span className="text-muted-foreground">-</span>),
  },
  {
    key: 'displayName',
    header: 'Display name',
    cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>,
  },
  { key: 'status', header: 'Status', cell: (r) => <StatusPill value={r.status} /> },
  { key: 'createdAt', header: 'Created', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.createdAt)}</span> },
  { key: 'updatedAt', header: 'Updated', cell: (r) => <span className="num text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
]

export function CourierMasterPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getVendors(client)
      .then((res) => {
        if (cancelled) return
        // Checked BEFORE the filter. `res` is typed VendorRow[] but the value
        // is a fetch body, so a failed read reaches `.filter` and throws
        // "res.filter is not a function" straight into the catch below, which
        // shows that sentence to an operator. Surviving is not the same as
        // being intelligible.
        if (!Array.isArray(res)) {
          setError('Unexpected response shape.')
          setRows(res)
          return
        }
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
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader title="Courier master" subtitle={Array.isArray(rows) ? `${rows.length} couriers` : undefined} />
        {rows === null ? (
          <SkeletonRows rows={4} cols={5} />
        ) : (
          <DataTable columns={COURIER_COLUMNS} rows={rows} getRowKey={(r) => r.id} emptyMessage="No couriers." />
        )}
      </Card>
    </div>
  )
}
