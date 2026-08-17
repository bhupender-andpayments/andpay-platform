import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
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
    maxWidth?: number
  }
}

// Narrow enough to hide a column you do not care about, wide enough to still
// grab its handle back.
const MIN_COLUMN_WIDTH = 60

// THE WIDTH GOES ON THIS DIV, never on the <th>/<td>. The table is `min-w-max`
// so it can outgrow its scroll container; an explicit width on a CELL fights
// that max-content resolution and the column then refuses to shrink below its
// own content, which makes dragging inward do nothing. A block div with an
// explicit width contributes exactly that width to max-content instead, so the
// table's intrinsic width follows the chosen width and shrinking works.
//
// It is also the one place truncation lives: a dragged-narrow column and a
// `maxWidth` column (Remarks, Description) clamp through the same `truncate`,
// so long text ends in an ellipsis rather than wrapping into ragged rows.
// With neither width set it renders NOTHING of its own, so an ordinary column
// is byte-identical to what it was before resizing existed.
function SizedCell({ width, maxWidth, children }: { width?: number; maxWidth?: number; children: ReactNode }) {
  if (width === undefined && maxWidth === undefined) return <>{children}</>
  return (
    <div
      className="truncate"
      style={width !== undefined ? { width } : { maxWidth }}
    >
      {children}
    </div>
  )
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
  // Cap this column's width, in px. Cells are nowrap and size to their content
  // by default, which is right for an id, a status or a date but wrong for a
  // Remarks or Description column: the full sentence would drag the table
  // absurdly wide. A column that sets this clamps to one line ending in an
  // ellipsis, and the operator can drag the header wider to read more.
  maxWidth?: number
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
  // Renders at the START of the toolbar row, for a grid that is its own titled
  // panel: the caller puts the heading here and the grid's own search moves
  // over to join toolbarRight. Without it the toolbar keeps its original shape
  // (search left, actions right), so every existing caller is untouched.
  toolbarLeft?: ReactNode
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
  toolbarLeft,
  pageSizeOptions,
  maxBodyHeight,
  refreshing = false,
  stickyFirstColumn = false,
}: DataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  // Widths the operator set by dragging a header edge, per column id. A column
  // absent here is automatic (content-sized), which is every column until it is
  // dragged, so the default look is unchanged. Session-scoped on purpose: this
  // is a "let me read this one cell" gesture, not a saved preference.
  const [widths, setWidths] = useState<Record<string, number>>({})

  // RESIZE IS IMPLEMENTED HERE rather than through TanStack's ColumnSizing
  // feature, and the reason is the content-sizing above. `header.getSize()`
  // falls back to the column's declared `size` or the library's 150px default,
  // and these columns declare none, so the first drag would snap a
  // content-sized 380px column down to 150 before it began tracking the
  // pointer. Measuring the header's REAL width at mousedown starts the drag
  // exactly where the column already sits.
  function startResize(e: ReactMouseEvent, columnId: string): void {
    e.preventDefault()
    e.stopPropagation() // never let the drag reach the header's sort button
    const th = (e.currentTarget as HTMLElement).closest('th')
    const startX = e.clientX
    const startWidth = widths[columnId] ?? th?.getBoundingClientRect().width ?? 0
    const onMove = (ev: MouseEvent): void => {
      setWidths((prev) => ({ ...prev, [columnId]: Math.max(MIN_COLUMN_WIDTH, startWidth + ev.clientX - startX) }))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('select-none', 'cursor-col-resize')
    }
    // On the BODY, so the pointer can leave the 5px handle mid-drag (it always
    // does) without the column stopping dead.
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('select-none', 'cursor-col-resize')
  }

  // Double-click the handle: back to automatic for that column.
  function clearResize(columnId: string): void {
    setWidths((prev) => {
      const next = { ...prev }
      delete next[columnId]
      return next
    })
  }

  const columnDefs = useMemo<ColumnDef<T>[]>(
    () =>
      columns.map((c) => ({
        id: c.key,
        accessorFn: (row: T) => (c.sortValue ? c.sortValue(row) : ''),
        header: c.header,
        cell: (ctx) => c.cell(ctx.row.original),
        enableSorting: Boolean(c.sortValue),
        enableGlobalFilter: Boolean(c.sortValue),
        meta: { align: c.align ?? 'left', ...(c.maxWidth !== undefined ? { maxWidth: c.maxWidth } : {}) },
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
      {(searchable || toolbarRight !== undefined || toolbarLeft !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          {/* The search box sits LEFT normally, but slides over to the action
              group once the caller claims the left slot with a heading. Two
              things fighting for the start of the row would push the heading
              off its own card. */}
          {(() => {
            const search = searchable ? (
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
            ) : null
            return toolbarLeft !== undefined ? (
              <>
                <div className="flex min-w-0 items-center gap-2">{toolbarLeft}</div>
                <div className="flex items-center gap-2">
                  {search}
                  {toolbarRight}
                </div>
              </>
            ) : (
              <>
                {search ?? <span />}
                {toolbarRight !== undefined && <div className="flex items-center gap-2">{toolbarRight}</div>}
              </>
            )
          })()}
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
            {/* `min-w-max` is what makes the `overflow-x-auto` above real.
                With `w-full` ALONE the table can never be wider than its
                container, so the scrollbar D-9 added never appeared and the
                browser resolved every wide table by shrinking columns and
                wrapping their text instead (a date stamp broken across five
                lines was the report). min-width:max-content lets the table
                ask for the room its content needs; `w-full` still wins
                whenever that is less than the container. */}
            <table className="w-full min-w-max border-collapse text-left text-[13px]">
              <thead className={maxBodyHeight !== undefined ? 'sticky top-0 z-20' : undefined}>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id} className="border-b border-border bg-muted">
                    {hg.headers.map((header) => {
                      const headerMeta = header.column.columnDef.meta as
                        | { align?: string; maxWidth?: number }
                        | undefined
                      const align = headerMeta?.align
                      const sortable = header.column.getCanSort()
                      const dir = header.column.getIsSorted()
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          className={`relative whitespace-nowrap bg-muted px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${
                            align === 'right' ? 'text-right' : 'text-left'
                          } ${stickyFirstColumn ? 'first:sticky first:left-0 first:z-30' : ''}`}
                        >
                          <SizedCell width={widths[header.column.id]} maxWidth={headerMeta?.maxWidth}>
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
                          </SizedCell>
                          {/* The column divider, which is ALSO the resize grip.
                              It is drawn permanently, not revealed on hover:
                              an affordance nobody can see is one nobody knows
                              exists, and the whole feature was undiscoverable
                              while this only appeared under the cursor. So it
                              reads as an ordinary column separator at rest
                              (a short hairline, inset from the text the way
                              MUI's grid draws it) and grows into a full-height
                              primary bar when the pointer is on it, which is
                              what says "you can pull this".

                              The outer span is a wider invisible hit area than
                              the visible line: a 1px target is unusable.
                              `touch-none` keeps a trackpad drag from scrolling
                              the table instead of sizing the column.

                              aria-hidden, and deliberately: it is a mouse-only
                              affordance with no keyboard path, and giving it a
                              role plus a label put "Resize X column" INTO the
                              column header's accessible name, so
                              `getByRole('columnheader', {name})` stopped
                              matching the header's own text. A decoration that
                              renames the thing it decorates is worse than an
                              unexposed one. */}
                          <span
                            aria-hidden="true"
                            data-resize-handle={header.column.id}
                            onMouseDown={(e) => startResize(e, header.column.id)}
                            onDoubleClick={() => clearResize(header.column.id)}
                            className="group/grip absolute right-0 top-0 z-10 flex h-full w-[11px] cursor-col-resize touch-none select-none items-center justify-center"
                          >
                            <span className="h-4 w-px rounded bg-border transition-all group-hover/grip:h-full group-hover/grip:w-[2px] group-hover/grip:bg-primary" />
                          </span>
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
                      const meta = cell.column.columnDef.meta as { align?: string; maxWidth?: number } | undefined
                      const align = meta?.align
                      return (
                        <td
                          key={cell.id}
                          className={`whitespace-nowrap px-4 py-2.5 text-foreground ${
                            align === 'right' ? 'text-right' : ''
                          } ${stickyFirstCell}`}
                        >
                          <SizedCell width={widths[cell.column.id]} maxWidth={meta?.maxWidth}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </SizedCell>
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
