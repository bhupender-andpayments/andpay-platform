import { useCallback, useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'
import { Button, Card, CardHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'
import { VendorCreateDialog } from './VendorCreateDialog.js'
import { VendorEditDialog } from './VendorEditDialog.js'

// The courier master (Phase 7 Task 8, spec 13 check 6). Per the grounded
// confirmation there is NO separate /ops/couriers route: the courier master
// is the vendor registry subset, filtered CLIENT-SIDE to type === 'COURIER'.
// Rows of type MANUFACTURER or PRINT must never appear here.
//
// CREATE landed 2026-08-17 (the L9 reversal), and posts to the SAME
// /ops/vendors route with the type pinned to COURIER, because a courier is a
// vendor row. That pinning is also what keeps this list honest: a create from
// this tab can never produce a row the tab then filters out of view.

function courierColumns(onEdit: (row: VendorRow) => void): ReadonlyArray<DataTableColumn<VendorRow>> {
  return [
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
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <button
          type="button"
          aria-label={`Edit courier ${r.displayName}`}
          className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onEdit(r)
          }}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      ),
    },
  ]
}

export function CourierMasterPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<VendorRow | null>(null)

  // Extracted from the effect so a successful create can re-read the list.
  const load = useCallback((): void => {
    getVendors(client)
      .then((res) => {
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
        setError(err instanceof Error ? err.message : 'Failed to load the courier master.')
      })
  }, [client])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="space-y-4">
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <Card>
        <CardHeader
          title="Courier master"
          subtitle={Array.isArray(rows) ? `${rows.length} couriers` : undefined}
          actions={
            <Button type="button" onClick={() => setAdding(true)}>
              Add courier
            </Button>
          }
        />
        {rows === null ? (
          <SkeletonRows rows={4} cols={5} />
        ) : (
          <DataTable columns={courierColumns(setEditing)} rows={rows} getRowKey={(r) => r.id} emptyMessage="No couriers." />
        )}
      </Card>
      <VendorCreateDialog open={adding} onOpenChange={setAdding} onCreated={load} fixedType="COURIER" />
      {editing !== null && (
        <VendorEditDialog
          vendor={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null)
          }}
          onSaved={load}
        />
      )}
    </div>
  )
}
