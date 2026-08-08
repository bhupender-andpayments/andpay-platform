import type { ReactNode } from 'react'

export interface DataTableColumn<T> {
  key: string
  header: string
  cell(row: T, index: number): ReactNode
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>
  rows: readonly T[]
  getRowKey?: (row: T, index: number) => string | number
  emptyMessage?: string
}

// A generic, presentational table for the read views the feature tasks
// (10 to 14) render (tiles/report rows, queue rows, vendor rows, upload
// results). It owns no data fetching and no authorization logic: callers
// supply already-fetched rows and column definitions.
export function DataTable<T>({ columns, rows, getRowKey, emptyMessage = 'No records.' }: DataTableProps<T>) {
  return (
    // THE TABLE MUST SCROLL INSIDE ITS OWN CONTAINER. Every caller renders this
    // inside a Card, and Card is `overflow-hidden`; the page itself is capped at
    // max-w-[1200px]. So a table wider than the card was CLIPPED with no
    // scrollbar, and the clipped region was unreachable at ANY viewport width,
    // because the cap means the card can never grow to meet it. Found in the
    // browser on Status Exceptions (11 columns, 1401px in a 1200px card): the
    // trailing Actions column, which holds Resolve, sat past the right edge and
    // an operator simply could not reach the control the queue exists for.
    // DataGrid, the sibling primitive, already wraps its table exactly this way.
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
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
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
