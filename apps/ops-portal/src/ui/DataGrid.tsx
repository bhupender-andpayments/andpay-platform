import { useMemo, useState, type ReactNode } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type RowData,
} from '@tanstack/react-table'
import { IconArrowUpDown, IconSearch, IconChevron } from './icons.js'
import { Input, SkeletonRows, EmptyState } from './primitives.js'

// Per-column presentation hint carried through TanStack's column meta.
declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: 'left' | 'right'
  }
}

// The one grid every list surface reuses (Task 6). Wraps TanStack Table
// (headless) with sort, a global text filter, and pagination; token-styled
// with explicit loading and empty states. Callers pass a simplified column
// spec so feature pages stay terse.
export interface GridColumn<T> {
  key: string
  header: string
  cell(row: T): ReactNode
  // Sort/search key. When present the header is sortable and the value feeds
  // the global filter; omit for a purely presentational column.
  sortValue?(row: T): string | number | null
  align?: 'left' | 'right'
}

export interface DataGridProps<T> {
  columns: ReadonlyArray<GridColumn<T>>
  rows: readonly T[]
  getRowKey?(row: T, index: number): string
  loading?: boolean
  emptyTitle?: string
  emptyMessage?: string
  searchable?: boolean
  searchPlaceholder?: string
  pageSize?: number
  onRowClick?(row: T): void
  toolbarRight?: ReactNode
}

export function DataGrid<T>({
  columns,
  rows,
  getRowKey,
  loading = false,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  searchable = true,
  searchPlaceholder = 'Search…',
  pageSize = 12,
  onRowClick,
  toolbarRight,
}: DataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')

  const columnDefs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c) => ({
        id: c.key,
        accessorFn: (row: T) => (c.sortValue ? c.sortValue(row) : ''),
        header: c.header,
        cell: (ctx) => c.cell(ctx.row.original),
        enableSorting: Boolean(c.sortValue),
        enableGlobalFilter: Boolean(c.sortValue),
        meta: { align: c.align ?? 'left' },
      })),
    [columns],
  )

  const table = useReactTable({
    data: rows as T[],
    columns: columnDefs,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
    getRowId: getRowKey ? (row, i) => getRowKey(row, i) : undefined,
  })

  const pageRows = table.getRowModel().rows
  const total = table.getFilteredRowModel().rows.length
  const pageIndex = table.getState().pagination.pageIndex
  const pageCount = table.getPageCount()

  return (
    <div>
      {(searchable || toolbarRight !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          {searchable ? (
            <div className="relative w-full max-w-xs">
              <IconSearch width={16} height={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <Input
                aria-label="Search"
                placeholder={searchPlaceholder}
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                className="h-9 pl-9"
              />
            </div>
          ) : (
            <span />
          )}
          {toolbarRight !== undefined && <div className="flex items-center gap-2">{toolbarRight}</div>}
        </div>
      )}

      {loading ? (
        <SkeletonRows rows={6} cols={Math.min(columns.length, 6)} />
      ) : total === 0 ? (
        <EmptyState title={emptyTitle} message={emptyMessage} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-line bg-surface-2">
                    {hg.headers.map((header) => {
                      const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align
                      const sortable = header.column.getCanSort()
                      const dir = header.column.getIsSorted()
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-subtle ${
                            align === 'right' ? 'text-right' : 'text-left'
                          }`}
                        >
                          {sortable ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className={`inline-flex items-center gap-1 hover:text-ink ${align === 'right' ? 'flex-row-reverse' : ''} ${dir ? 'text-ink' : ''}`}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <IconArrowUpDown width={13} height={13} className={dir ? 'text-brand' : 'text-subtle/70'} />
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </th>
                      )
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    className={`border-b border-line/70 last:border-0 ${
                      onRowClick ? 'cursor-pointer hover:bg-brand-weak/40' : 'hover:bg-surface-2/60'
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align
                      return (
                        <td key={cell.id} className={`px-4 py-2.5 text-ink ${align === 'right' ? 'text-right' : ''}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-2.5 text-[13px] text-muted">
              <span>
                <span className="num text-ink">{total}</span> {total === 1 ? 'row' : 'rows'}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  className="flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <IconChevron width={16} height={16} className="rotate-180" />
                </button>
                <span className="num px-1 text-ink">
                  {pageIndex + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  className="flex h-8 w-8 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-40"
                  aria-label="Next page"
                >
                  <IconChevron width={16} height={16} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
