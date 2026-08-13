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
import { SearchSelect } from '../components/Picker.js'
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
  // Renders a "Rows per page" select in the footer and keeps the footer
  // visible even on a single page (the reference layout: "Rows per page: 10,
  // 1-7 of 10, < >"). Without it the legacy pageCount>1-only footer holds.
  pageSizeOptions?: readonly number[]
  // Caps the BODY height (e.g. '60vh'): the rows scroll inside the grid under
  // a sticky header, so a long list never turns into whole-page scroll.
  maxBodyHeight?: string
  // True while the caller is re-fetching rows it already has: the current
  // rows stay visible but blurred under a spinner, which reads as "updating"
  // rather than the skeleton's "empty".
  refreshing?: boolean
  // Pins the first column under horizontal scroll, so the row's identity
  // (a device serial, an id) never scrolls out of view.
  stickyFirstColumn?: boolean
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
  pageSizeOptions,
  maxBodyHeight,
  refreshing = false,
  stickyFirstColumn = false,
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
  const currentPageSize = table.getState().pagination.pageSize
  const rangeStart = total === 0 ? 0 : pageIndex * currentPageSize + 1
  const rangeEnd = Math.min(total, (pageIndex + 1) * currentPageSize)
  const showFooter = pageSizeOptions !== undefined ? total > 0 : pageCount > 1
  // STICKY LAYERING, AND THE ORDER MATTERS. Sticky positioning needs an opaque
  // background or scrolled content shows through the pinned cells; it also
  // needs DISTINCT z-indexes, because two sticky elements at the same z-index
  // are resolved by DOM order and tbody comes after thead. That is exactly what
  // went wrong: the header row and the pinned first column were both `z-10`, so
  // scrolling down painted the first body cell (a device serial) on top of the
  // header. Header sits above body; the header's own pinned corner cell sits
  // above the rest of the header; the refreshing overlay sits above everything.
  const stickyFirstCell = stickyFirstColumn ? 'first:sticky first:left-0 first:z-10 first:bg-card' : ''

  return (
    <div>
      {(searchable || toolbarRight !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          {searchable ? (
            <div className="relative w-full max-w-xs">
              <IconSearch width={16} height={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
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
          <div
            className={`relative overflow-x-auto ${maxBodyHeight !== undefined ? 'overflow-y-auto' : ''}`}
            style={maxBodyHeight !== undefined ? { maxHeight: maxBodyHeight } : undefined}
          >
            {refreshing && (
              <div className="absolute inset-0 z-40 flex items-start justify-center bg-background/40 pt-16 backdrop-blur-[2px]">
                <span className="rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">Updating…</span>
              </div>
            )}
            <table className="w-full border-collapse text-left text-[13px]">
              <thead className={maxBodyHeight !== undefined ? 'sticky top-0 z-20' : undefined}>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-border bg-muted">
                    {hg.headers.map((header) => {
                      const align = (header.column.columnDef.meta as { align?: string } | undefined)?.align
                      const sortable = header.column.getCanSort()
                      const dir = header.column.getIsSorted()
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          className={`bg-muted px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${
                            align === 'right' ? 'text-right' : 'text-left'
                          } ${stickyFirstColumn ? 'first:sticky first:left-0 first:z-30' : ''}`}
                        >
                          {sortable ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className={`inline-flex items-center gap-1 hover:text-foreground ${align === 'right' ? 'flex-row-reverse' : ''} ${dir ? 'text-foreground' : ''}`}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <IconArrowUpDown width={13} height={13} className={dir ? 'text-primary' : 'text-muted-foreground/70'} />
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
                    className={`border-b border-border/70 last:border-0 ${
                      onRowClick ? 'cursor-pointer hover:bg-primary/5' : 'hover:bg-muted/60'
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align
                      return (
                        <td
                          key={cell.id}
                          className={`px-4 py-2.5 text-foreground ${align === 'right' ? 'text-right' : ''} ${stickyFirstCell}`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {showFooter && (
            <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
              {pageSizeOptions !== undefined && (
                // The SAME picker the filters use, not a native <select>: the
                // OS-drawn panel came up as a dark menu with a blue highlight
                // row, sitting inside a white table footer and matching nothing
                // around it. Search is off - three numbers need no search box.
                <span className="flex items-center gap-2">
                  <span id="rowsPerPageLabel">Rows per page:</span>
                  <SearchSelect
                    id="rowsPerPage"
                    aria-labelledby="rowsPerPageLabel"
                    placeholder=""
                    searchable={false}
                    className="h-7 w-[4.75rem] border-border bg-card text-[13px]"
                    options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
                    value={String(currentPageSize)}
                    onChange={(v) => table.setPageSize(Number(v))}
                  />
                </span>
              )}
              <span className="num">
                {rangeStart}-{rangeEnd} of {total}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <IconChevron width={16} height={16} className="rotate-180" />
                </button>
                <button
                  type="button"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40"
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
