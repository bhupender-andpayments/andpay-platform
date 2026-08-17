import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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
    // THE OTHER HALF, and the pair is the invariant: a scroll container around
    // a `w-full`-only table can never scroll, because the table is pinned to
    // the container's own width. It cannot overflow, so instead the browser
    // shrinks the columns and wraps their text - which is how a date stamp
    // ended up broken across five lines while this test still passed.
    // min-w-max lets the table outgrow the container so the wrapper above has
    // something to scroll. Either class without the other is a known bug:
    // wrapper alone is the silent squeeze, min-w-max alone is D-9's clipping.
    expect(table?.className).toContain('min-w-max')
  })

  it('sizes cells to their content by default, and clamps a maxWidth column with an ellipsis', () => {
    // Default nowrap is what lets a column GROW rather than stack its value
    // into fragments. `maxWidth` is the answer for genuinely long free text (a
    // Remarks or Description column): one line, ellipsis, bounded - NOT
    // wrapping, which would give ragged row heights down the table.
    const wide: ReadonlyArray<DataTableColumn<Row>> = [
      { key: 'name', header: 'Name', cell: (r) => r.name },
      { key: 'notes', header: 'Notes', cell: () => 'a very long note', maxWidth: 240 },
    ]
    const { container } = render(<DataTable columns={wide} rows={[{ id: '1', name: 'a' }]} getRowKey={(r) => r.id} />)
    const cells = container.querySelectorAll('tbody td')
    // An ordinary column renders no sizing wrapper at all, so it stays exactly
    // what it was before any of this existed.
    expect(cells[0]?.querySelector('div.truncate')).toBeNull()
    const clamped = cells[1]?.querySelector('div.truncate') as HTMLElement | null
    expect(clamped).not.toBeNull()
    expect(clamped?.style.maxWidth).toBe('240px')
  })

  it('resizes a column by dragging its header handle, and double-click restores automatic', () => {
    const { container } = render(<DataTable columns={columns} rows={[{ id: '1', name: 'a' }]} getRowKey={(r) => r.id} />)
    const handle = container.querySelector('[data-resize-handle="name"]') as HTMLElement
    expect(handle).not.toBeNull()

    // jsdom lays nothing out, so getBoundingClientRect() is all zeros and the
    // drag's start width is 0. That makes the resulting width exactly the
    // pointer delta, which is what lets this pin the WIRING (listeners on
    // document, state update, width reaching the cell) without pretending to
    // test layout jsdom cannot do.
    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document)

    const sized = container.querySelector('tbody td div.truncate') as HTMLElement | null
    expect(sized?.style.width).toBe('300px')

    fireEvent.doubleClick(handle)
    expect(container.querySelector('tbody td div.truncate')).toBeNull()
  })

  it('never lets a drag collapse a column past the minimum that keeps its handle grabbable', () => {
    const { container } = render(<DataTable columns={columns} rows={[{ id: '1', name: 'a' }]} getRowKey={(r) => r.id} />)
    const handle = container.querySelector('[data-resize-handle="name"]') as HTMLElement
    // Dragging far to the LEFT: without the floor this would go negative and
    // the column (and its handle) would be unreachable for the rest of the
    // session, since the only way back is to grab that same handle.
    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(document, { clientX: -500 })
    fireEvent.mouseUp(document)
    const sized = container.querySelector('tbody td div.truncate') as HTMLElement | null
    expect(sized?.style.width).toBe('60px')
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
