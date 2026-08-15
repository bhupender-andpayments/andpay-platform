import type { ReactNode } from 'react'
import { DataGrid, type GridColumn } from '../ui/DataGrid.js'

export interface DataTableColumn<T> {
  key: string
  header: string
  cell(row: T, index: number): ReactNode
  /**
   * Opt this column into the grid's sorting and global search. Optional so the
   * many existing callers keep compiling; a column without it renders but is
   * not sortable and does not feed the search box, exactly DataGrid's own rule.
   */
  sortValue?(row: T): string | number
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>
  rows: readonly T[]
  getRowKey?: (row: T, index: number) => string | number
  emptyMessage?: string
  /** Forwarded to the grid. Search only finds columns that carry sortValue. */
  searchPlaceholder?: string
  pageSize?: number
}

// DELEGATES TO THE COMMON DataGrid (user's standing rule, 13 Aug 2026): every
// data list in the portal is the one grid the Inventory page uses - same look,
// same filter row, same pagination - never a second table implementation that
// drifts. This component survives only as an adapter so its many callers keep
// their simpler column shape; new surfaces should use DataGrid directly.
//
// The non-array guard this component was famous for is preserved: `rows` is
// typed `readonly T[]` but the value is whatever a fetch returned, and a
// non-array reaching the grid throws during render and takes the whole screen
// down (it happened three times in two days). Coercing quietly to [] would
// render the caller's emptyMessage and make a failed read indistinguishable
// from a genuinely empty list, so the non-array case says what it knows and
// nothing more.
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  emptyMessage = 'No records.',
  searchPlaceholder,
  pageSize,
}: DataTableProps<T>) {
  const usable = Array.isArray(rows)
  const safeRows: readonly T[] = usable ? rows : []

  const gridColumns: ReadonlyArray<GridColumn<T>> = columns.map((c, colIndex) => ({
    key: c.key,
    header: c.header,
    // DataGrid's cell takes only the row; no existing caller reads the index
    // (verified before the delegation), so it is supplied as the column's own
    // position which is stable per render.
    cell: (row: T) => c.cell(row, colIndex),
    sortValue: c.sortValue,
  }))

  return (
    <DataGrid
      columns={gridColumns}
      rows={safeRows}
      getRowKey={getRowKey ? (row, index) => String(getRowKey(row, index)) : undefined}
      emptyTitle={usable ? 'Nothing here' : 'Could not display these rows'}
      emptyMessage={usable ? emptyMessage : 'The response was not a list. A load error above says more if the caller caught one.'}
      searchPlaceholder={searchPlaceholder}
      pageSize={pageSize ?? 20}
    />
  )
}

// The legacy presentational table, kept for the ONE case the grid delegation
// cannot serve: rows that hold FOCUSED INPUTS (the damage-case note box). The
// grid rebuilds its rows through TanStack on each render, which remounts a
// row's input mid-typing and drops focus after the first character. A plain
// keyed <tr> map does not. Use this only for input-bearing rows; every plain
// data list uses DataTable (the grid) above.
export function PlainTable<T>({ columns, rows, getRowKey, emptyMessage = 'No records.' }: DataTableProps<T>) {
  const usable = Array.isArray(rows)
  const safeRows: readonly T[] = usable ? rows : []
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-2 font-semibold text-foreground">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {safeRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-muted-foreground">
                {usable ? emptyMessage : 'Could not display these rows.'}
              </td>
            </tr>
          ) : (
            safeRows.map((row, index) => (
              <tr key={getRowKey ? getRowKey(row, index) : index} className="border-b border-border">
                {columns.map((column) => (
                  <td key={column.key} className="px-3 py-2 text-foreground">
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
