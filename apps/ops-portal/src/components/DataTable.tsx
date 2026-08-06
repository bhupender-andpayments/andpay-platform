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
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-line">
          {columns.map((column) => (
            <th key={column.key} scope="col" className="px-3 py-2 font-semibold text-ink">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="px-3 py-6 text-center text-subtle">
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((row, index) => (
            <tr key={getRowKey ? getRowKey(row, index) : index} className="border-b border-line">
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2 text-ink">
                  {column.cell(row, index)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}
