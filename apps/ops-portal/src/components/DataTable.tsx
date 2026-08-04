import type { ReactNode } from 'react'

export interface DataTableColumn<T> {
  key: string
  header: string
  cell(row: T, index: number): ReactNode
  // Optional right-alignment for numeric columns (demo skin).
  align?: 'left' | 'right'
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>
  rows: readonly T[]
  getRowKey?: (row: T, index: number) => string | number
  emptyMessage?: string
}

// A generic, presentational table for the read views the feature pages render.
// Demo skin: token-styled (uppercase hairline header, hairline rows, hover),
// same public API as before so every caller and its tests are unchanged. It
// owns no data fetching and no authorization logic.
export function DataTable<T>({ columns, rows, getRowKey, emptyMessage = 'No records.' }: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-surface-2">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-subtle ${
                  column.align === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-[13px] text-muted">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr key={getRowKey ? getRowKey(row, index) : index} className="border-b border-line/70 last:border-0 hover:bg-surface-2/60">
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`px-4 py-2.5 align-top text-ink ${column.align === 'right' ? 'text-right' : ''}`}
                  >
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
