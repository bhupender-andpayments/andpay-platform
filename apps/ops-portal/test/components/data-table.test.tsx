import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DataTable, type DataTableColumn } from '../../src/components/DataTable.js'

// D-9: the browser found that a DataTable wider than its Card was CLIPPED with
// no scrollbar, and unreachable at ANY viewport width, because every caller
// renders it inside `Card` (overflow-hidden) under a page capped at
// max-w-[1200px]. On Status Exceptions (11 columns) the trailing Actions
// column holds Resolve, so the control the queue exists for could not be
// reached at all.
//
// jsdom CANNOT catch that: it lays nothing out, so widths are 0 and nothing
// ever overflows. What jsdom CAN pin is the STRUCTURAL invariant that made the
// fix work, which is what this guards: the table is wrapped in a container
// that scrolls on the x axis. DataGrid, the sibling primitive, already does
// exactly this.

interface Row {
  id: string
  name: string
}

const columns: ReadonlyArray<DataTableColumn<Row>> = [
  { key: 'name', header: 'Name', cell: (r) => r.name },
  { key: 'action', header: 'Actions', cell: () => <button type="button">Resolve</button> },
]

afterEach(() => {
  cleanup()
})

describe('DataTable', () => {
  it('wraps the table in an x-scrolling container, so a wide table stays reachable', () => {
    const { container } = render(<DataTable columns={columns} rows={[{ id: '1', name: 'a' }]} getRowKey={(r) => r.id} />)
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    const wrapper = table?.parentElement
    // The class, not a computed width: jsdom computes no layout, so the class
    // IS the observable. A bare <table> whose parent is the Card is exactly the
    // clipped shape this replaced.
    expect(wrapper?.className).toContain('overflow-x-auto')
  })

  it('still renders every column and the row cells inside that wrapper', () => {
    // The wrapper must not change what the table shows. If a future refactor
    // moves the scroll container it must keep the content addressable, which is
    // what the trailing action cell proves.
    render(<DataTable columns={columns} rows={[{ id: '1', name: 'Kirana Corner' }]} getRowKey={(r) => r.id} />)
    expect(screen.getByText('Kirana Corner')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy()
  })

  it('renders the empty message across the full column span', () => {
    render(<DataTable columns={columns} rows={[]} emptyMessage="No status exceptions." />)
    const cell = screen.getByText('No status exceptions.')
    expect(cell.getAttribute('colspan')).toBe(String(columns.length))
  })
})
