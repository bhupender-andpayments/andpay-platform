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

  it('renders the empty message', () => {
    // Since the delegation to the common DataGrid (13 Aug 2026) the empty
    // state is the grid's own EmptyState block, not a colspan cell, so the
    // assertion is about the message being visible, not about table geometry.
    render(<DataTable columns={columns} rows={[]} emptyMessage="No status exceptions." />)
    expect(screen.getByText('No status exceptions.')).toBeTruthy()
  })

  // A non-array body has now taken a whole page down three times in two days
  // (VendorSuspendButton, the shipments region on Dispatches, Inventory). The
  // shape is always the same: a read returns an error object instead of a list,
  // the caller assigns it straight into state, and `rows.map` throws during
  // render. React unmounts the tree, so the operator loses the entire screen
  // rather than one table. Guarding at each call site has not held, because the
  // guard has to be remembered every time; the primitive is the one place that
  // covers every existing caller and every future one.
  //
  // `rows` is typed `readonly T[]`, so this cannot happen according to the
  // types. It happened anyway, three times, which is the point: the value comes
  // from a fetch and the type is an assertion about it, not a check of it.
  it('survives a response body that is not an array, instead of taking the page down', () => {
    // Exactly the shape that caused it: an error envelope where a list was
    // expected. `as never` because only a runtime value can be this wrong.
    const body = { statusCode: 500, message: 'Internal Server Error' } as never
    expect(() => render(<DataTable columns={columns} rows={body} />)).not.toThrow()
  })

  it('says the rows could not be displayed, and does NOT claim the list is empty', () => {
    // The important half. Coercing silently to [] would render the caller's
    // emptyMessage, so a failed read would be indistinguishable from a genuinely
    // empty one and the screen would state something false. DataTable cannot
    // know WHY the body is not a list, but it can refuse to say "none".
    render(<DataTable columns={columns} rows={undefined as never} emptyMessage="No vendors." />)
    expect(screen.queryByText('No vendors.')).toBeNull()
    expect(screen.getByText(/could not display these rows/i)).toBeTruthy()
  })
})
