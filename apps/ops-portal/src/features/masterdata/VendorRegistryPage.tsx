import { useCallback, useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useAuth } from '../../auth/AuthContext.js'
import { DataTable, type DataTableColumn } from '../../components/DataTable.js'
import { getVendors, type VendorRow } from '../../api/endpoints.js'
import { Button, Card, CardHeader, ErrorNote, StatusPill, CodeChip, SkeletonRows } from '../../ui/primitives.js'
import { fmtDate } from '../../ui/format.js'
import { VendorCreateDialog } from './VendorCreateDialog.js'
import { VendorEditDialog } from './VendorEditDialog.js'

// The full vendor registry (Phase 7 Task 8, spec 13 check 6): every vendor
// row the platform-only /ops/vendors read returns, regardless of type
// (MANUFACTURER | PRINT | COURIER).
//
// CREATE landed 2026-08-17 (the L9 reversal); EDIT landed 18 Aug 2026, on a
// route (POST /ops/vendors/:id/edit) that already existed and had never been
// called from the portal. Suspend, activate and deactivate remain separate
// deferred actions and are deliberately still absent here.

function vendorColumns(onEdit: (row: VendorRow) => void): ReadonlyArray<DataTableColumn<VendorRow>> {
  return [
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
    {
      key: 'actions',
      header: '',
      cell: (r) => (
        <button
          type="button"
          aria-label={`Edit vendor ${r.displayName}`}
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

export function VendorRegistryPage() {
  const { client } = useAuth()
  const [rows, setRows] = useState<VendorRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<VendorRow | null>(null)

  // Extracted from the effect so a successful create can re-read the list. A
  // create is a server-side write; refetching is what makes the new row appear
  // with the fields the SERVER decided (status, timestamps) rather than a
  // locally guessed row.
  const load = useCallback((): void => {
    getVendors(client)
      .then((res) => {
        // `res` is TYPED VendorRow[], but the type is an assertion about a
        // fetch body and not a check of it. A failed read arrives here as an
        // error envelope, and the subtitle below then prints "undefined
        // vendors". Say what happened; the value still goes into state so
        // DataTable can refuse to render it as an empty list.
        if (!Array.isArray(res)) setError('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load vendors.')
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
          title="Vendor registry"
          subtitle={Array.isArray(rows) ? `${rows.length} vendors` : undefined}
          actions={
            <Button type="button" onClick={() => setAdding(true)}>
              Add vendor
            </Button>
          }
        />
        {rows === null ? (
          <SkeletonRows rows={5} cols={6} />
        ) : (
          <DataTable columns={vendorColumns(setEditing)} rows={rows} getRowKey={(r) => r.id} emptyMessage="No vendors." />
        )}
      </Card>
      <VendorCreateDialog open={adding} onOpenChange={setAdding} onCreated={load} />
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
