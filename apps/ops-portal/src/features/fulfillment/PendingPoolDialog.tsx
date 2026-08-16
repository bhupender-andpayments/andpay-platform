import type { ReactNode } from 'react'
import { DataGrid, type GridColumn } from '../../ui/DataGrid.js'
import type { PoolEntryRow } from '../../api/endpoints.js'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'

// The pending pool used to sit ALWAYS-VISIBLE at the bottom of /batches with
// its own page-level Toolbar of filters, and the page was a long scroll of
// tables no operator asked for on entry. It lives here now, behind a "View
// pool" button in the Ready-to-batch card header: the page opens on the
// summary and the batches list, and the pool is one click away when an
// operator wants to inspect what is queued.
//
// Search LIVES INSIDE the grid (DataGrid's own searchPlaceholder + searchable),
// so this dialog does not carry a Toolbar of its own; there is one search box,
// the one on the table itself.

export function PendingPoolDialog({
  open,
  onOpenChange,
  rows,
  loading,
  columns,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: readonly PoolEntryRow[]
  loading: boolean
  columns: readonly GridColumn<PoolEntryRow>[]
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(1200px,95vw)]">
        <DialogHeader>
          <DialogTitle>Pending pool</DialogTitle>
          <DialogDescription>
            Rows still waiting for a batch, oldest first. A trigger claims every one of them. Rows already batched are in
            the Batches grid; rows on hold are in Queues.
          </DialogDescription>
        </DialogHeader>
        {/* The grid gets an explicit maxBodyHeight so it can scroll ITSELF,
            because the wrapper cannot: the parent DialogContent already sets
            an overflow to trap focus, so a nested `overflow: hidden` here
            just clipped the tail of the rows and stole the scrollbar. */}
        <DataGrid
          columns={columns}
          rows={rows}
          loading={loading}
          getRowKey={(r) => r.asgnId}
          searchPlaceholder="Search merchant, bank or dispatch…"
          emptyTitle="Nothing in the pool"
          emptyMessage="Committed bank rows land here until a batch triggers."
          pageSize={20}
          pageSizeOptions={[20, 50, 100]}
          stickyFirstColumn
          maxBodyHeight="60vh"
        />
      </DialogContent>
    </Dialog>
  )
}
