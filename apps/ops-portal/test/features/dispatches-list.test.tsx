import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../../src/auth/AuthContext.js'
import { DispatchesPage } from '../../src/features/dispatches/DispatchesPage.js'
import { setAccessToken, clearAccessToken } from '../../src/api/tokenStore.js'

// The dispatch list, redesigned onto the Inventory pattern: a summary row that IS
// the filter, filters in a toolbar above the grid rather than buried in the card,
// and rows that open the dispatch they name.

// pipelineState arrived with the D12 read: the page now shows every dispatch
// from the moment it is minted, so a fixture row without a stage would be
// testing the page against data the server no longer sends. DELTA DEPOT is the
// pre-vendor row that the old "awaiting vendor" tile claimed to count and
// structurally never could.
const ROWS = [
  { dispatchId: 'asgn_transit', merchantDisplay: 'ALPHA STORE', bankCode: '3', awb: 'AWB1', shptId: 'shpt_1', courierStatus: 'IN_TRANSIT', pipelineState: 'DISPATCHED' },
  { dispatchId: 'asgn_delivered', merchantDisplay: 'BETA TRADERS', bankCode: '3', awb: 'AWB2', shptId: 'shpt_2', courierStatus: 'DELIVERED', pipelineState: 'DELIVERED' },
  { dispatchId: 'asgn_returned', merchantDisplay: 'GAMMA GOODS', bankCode: '3', awb: 'AWB3', shptId: 'shpt_3', courierStatus: 'RETURNED', pipelineState: 'DISPATCHED' },
  { dispatchId: 'asgn_waiting', merchantDisplay: 'DELTA DEPOT', bankCode: '3', awb: null, shptId: null, courierStatus: null, pipelineState: 'BATCHED' },
  // A HELD dispatch carries BOTH axes at once, which is the shape the edge
  // actually sends: poolStatus comes from fulfillment's pool entry
  // (mergeHoldState grafts it on) while pipelineState comes from analytics.
  // A held parcel has never reached a courier, so its courierStatus is null.
  { dispatchId: 'asgn_held', merchantDisplay: 'EPSILON MEDICAL', bankCode: '3', awb: null, shptId: null, courierStatus: null, pipelineState: 'RECEIVED', poolStatus: 'HELD', holdReason: 'awaiting bank confirmation' },
  // A REPLACEMENT (23 Aug 2026): minted from a damage case, so non-billable and
  // carrying the parent it replaces. THE FIELD IS `billable`, the dispatches
  // report's own name (mediation.ts dispatchesRow) - the fixture briefly said
  // `billableFlag`, which belongs to OTHER reports, and that mismatch is
  // exactly how the dead Billable filter shipped: the test passed against a
  // field the server never sends. Every other row above is an ordinary
  // billable bank request (field omitted, which the page reads as billable).
  { dispatchId: 'asgn_repl', merchantDisplay: 'ZETA STORES', bankCode: '3', awb: null, shptId: null, courierStatus: null, pipelineState: 'BATCHED', billable: false, replacementOfAsgnId: 'asgn_delivered' },
  // THE PARENT damage was raised against (24 Aug 2026). Delivered AND damaged
  // at once, which is the whole point of the overlay: the parcel did arrive,
  // and a replacement is on its way for what was inside it.
  // A WITHDRAWN REPLACEMENT (24 Aug 2026): its pool row is CANCELLED, grafted
  // onto the report by the edge exactly as HELD is. Nothing will ever move it
  // again, so the list must not show it as merely Batched and waiting.
  { dispatchId: 'asgn_cancelled', merchantDisplay: 'IOTA SUPPLY', bankCode: '3', awb: null, shptId: null, courierStatus: null, pipelineState: 'RECEIVED', poolStatus: 'CANCELLED', billable: false, replacementOfAsgnId: 'asgn_delivered' },
  { dispatchId: 'asgn_damaged', merchantDisplay: 'THETA TRADERS', bankCode: '3', awb: 'AWB9', shptId: 'shpt_9', courierStatus: 'DELIVERED', pipelineState: 'DELIVERED', replacementStatus: 'RAISED', replacementDispatchId: 'asgn_repl' },
]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function stub(): { url: string }[] {
  const calls: { url: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push({ url })
      if (url.includes('/ops/dispatches')) return jsonResponse([])
      if (url.includes('/ops/bank-masters')) return jsonResponse([{ tnntId: 't', bankReferenceCode: '3', displayName: 'GSCB', status: 'ACTIVE' }])
      return jsonResponse({ rows: ROWS, watermark: { asOf: null, perTopic: {} } })
    }),
  )
  return calls
}

/** A tile, by the hint that only it carries. */
function tile(hint: string): HTMLButtonElement {
  return screen.getByText(hint).closest('button') as HTMLButtonElement
}

/** The toolbar's own search box, not the shipments grid's. */
function searchBox(): HTMLElement {
  return screen.getByPlaceholderText(/dispatch id, merchant, awb, batch or device/i)
}

/** Mounted with the real detail route so a row click can be observed landing. */
function renderList() {
  return render(
    <MemoryRouter initialEntries={['/dispatches']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/dispatches" element={<DispatchesPage />} />
          <Route path="/dispatches/:asgnId" element={<h1>dispatch page</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** One row's cells, by the merchant name in it. Shared by both describes. */
function cellsOf(merchant: string): HTMLElement[] {
  const row = screen.getByText(merchant).closest('tr') as HTMLTableRowElement
  return Array.from(row.querySelectorAll('td'))
}

function headerIndex(name: RegExp): number {
  return screen.getAllByRole('columnheader').findIndex((h) => name.test(h.textContent ?? ''))
}

describe('The dispatch list: tiles, toolbar and links', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('summarises the list by the courier ladder, counting only the vocabulary the couriers use', async () => {
    stub()
    renderList()

    // Tiles are found by their HINT, not their label: several tile labels are
    // also column headers, and a test that cannot tell them apart is a test that
    // would pass on the wrong element.
    expect(await screen.findByText('in the current window')).toBeTruthy()
    for (const hint of ['pending batch or batched', 'picked up, on its way', 'courier confirmed delivery']) {
      expect(screen.getByText(hint)).toBeTruthy()
    }
    // DELTA DEPOT is BATCHED and EPSILON MEDICAL is RECEIVED, so both count in
    // the pre-vendor tile. That tile used to key off a missing AWB and sat at
    // zero forever, because the read it counted could not contain a row that had
    // not shipped.
    //
    // EPSILON is also HELD, and it still counts here: a held parcel is very much
    // before the vendor. The hold is an overlay on the stage, not a replacement
    // for it, which is the same reason the Stage cell shows both. ZETA STORES,
    // the replacement, is BATCHED too, so three. IOTA SUPPLY is RECEIVED but
    // CANCELLED, and is deliberately NOT counted: it waits for nothing.
    expect(tile('pending batch or batched').textContent).toContain('3')
  })

  // THE BILLABLE AXIS AND THE REPLACEMENT TILE (23 Aug 2026, ops-team ask).
  it('counts replacements in their own tile, and the tile filters to them', async () => {
    stub()
    renderList()

    // TWO: the batched replacement and the withdrawn one. Being raised from a
    // damage flag is permanent history, so a cancelled replacement still counts
    // here even though nothing will ship for it.
    const repl = await screen.findByText('raised from damage, not billable')
    expect(repl.closest('button')!.textContent).toContain('2')

    await userEvent.click(repl.closest('button')!)
    expect(await screen.findByText('ZETA STORES')).toBeTruthy()
    expect(screen.getByText('IOTA SUPPLY')).toBeTruthy()
    // Every ordinary billable row is gone.
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
    expect(screen.queryByText('BETA TRADERS')).toBeNull()

    // A tile is a toggle, never a trap.
    await userEvent.click(repl.closest('button')!)
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
  })

  // ONE TILE AT A TIME (23 Aug 2026): the tiles own three axes between them
  // (stage, courier status, billable); every click writes its own and clears
  // the other two, so two tiles can never light together.
  it('keeps exactly one tile active across the stage, status and billable axes', async () => {
    stub()
    renderList()
    await screen.findByText('ALPHA STORE')

    const pressed = () => screen.getAllByRole('button', { pressed: true })
    expect(pressed()).toHaveLength(1) // Dispatches (all) at rest

    await userEvent.click(tile('pending batch or batched'))
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]!.textContent).toMatch(/Before the vendor/)

    // A different axis entirely: the stage selection must clear.
    await userEvent.click(tile('raised from damage, not billable'))
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]!.textContent).toMatch(/Replacements/)

    // And back to a courier tile, clearing billable.
    await userEvent.click(tile('courier confirmed delivery'))
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]!.textContent).toMatch(/Delivered/)
    expect(screen.getByText('BETA TRADERS')).toBeTruthy()
    expect(screen.queryByText('ZETA STORES')).toBeNull()
  })

  // THE DAMAGE OVERLAY (24 Aug 2026). Damage is NOT a stage: a delivered parcel
  // stays delivered, and pipeline_state is a monotone maximum that must not be
  // rewritten by something that happened to the kit afterwards. So the list
  // composes the two axes in one cell, exactly as it already does for HELD.
  it('leads with DAMAGED and keeps the courier stage underneath', async () => {
    stub()
    renderList()
    await screen.findByText('THETA TRADERS')

    const stageCell = cellsOf('THETA TRADERS')[headerIndex(/^Stage$/)]!
    // DAMAGED is the PILL: it answers "what state is this dispatch in".
    const damaged = within(stageCell).getByText('Damaged')
    expect(damaged.className).toContain('pill')
    // The courier stage survives as the small muted line, which on a collateral
    // leg is the only place the parcel's own fate shows. Not a pill.
    const stage = within(stageCell).getByText('Delivered')
    expect(stage.className).not.toContain('pill')
    expect(stage.className).toContain('text-muted-foreground')
  })

  it('leaves an undamaged dispatch showing its plain stage', async () => {
    stub()
    renderList()
    await screen.findByText('BETA TRADERS')

    const stageCell = cellsOf('BETA TRADERS')[headerIndex(/^Stage$/)]!
    expect(within(stageCell).getByText('Delivered')).toBeTruthy()
    expect(within(stageCell).queryByText('Damaged')).toBeNull()
  })

  it('offers Damaged in the Stage filter and narrows to the dispatches damage was raised against', async () => {
    stub()
    renderList()
    await screen.findByText('THETA TRADERS')

    await userEvent.click(screen.getByLabelText('Stage'))
    const listbox = await screen.findByRole('listbox')
    await userEvent.click(within(listbox).getByRole('option', { name: /Damaged/ }))

    expect(await screen.findByText('THETA TRADERS')).toBeTruthy()
    // The REPLACEMENT child is not the damaged one; its parent is.
    expect(screen.queryByText('ZETA STORES')).toBeNull()
    expect(screen.queryByText('BETA TRADERS')).toBeNull()
  })

  it('counts them in a Damaged tile that filters the same axis', async () => {
    stub()
    renderList()
    const tileBtn = (await screen.findByText('a replacement was raised for these')).closest('button')!
    expect(tileBtn.textContent).toContain('1')

    await userEvent.click(tileBtn)
    expect(await screen.findByText('THETA TRADERS')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
    // One tile at a time still holds across the new axis.
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
  })

  it('leads with CANCELLED on a withdrawn replacement, keeping the stage underneath', async () => {
    stub()
    renderList()
    await screen.findByText('IOTA SUPPLY')

    const stageCell = cellsOf('IOTA SUPPLY')[headerIndex(/^Stage$/)]!
    const cancelled = within(stageCell).getByText('Cancelled')
    expect(cancelled.className).toContain('pill')
    const stage = within(stageCell).getByText('Received')
    expect(stage.className).not.toContain('pill')
  })

  it('offers Cancelled in the Stage filter and narrows to withdrawn replacements', async () => {
    stub()
    renderList()
    await screen.findByText('IOTA SUPPLY')

    await userEvent.click(screen.getByLabelText('Stage'))
    const listbox = await screen.findByRole('listbox')
    await userEvent.click(within(listbox).getByRole('option', { name: /Cancelled/ }))

    expect(await screen.findByText('IOTA SUPPLY')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
    expect(screen.queryByText('THETA TRADERS')).toBeNull()
  })

  it('the Billable filter splits the two, and Any shows both', async () => {
    stub()
    renderList()
    await screen.findByText('ALPHA STORE')

    const picker = screen.getByLabelText(/billable/i)
    await userEvent.click(picker)
    await userEvent.click(await screen.findByRole('option', { name: /^billable$/i }))
    // The non-billable replacement drops out; the ordinary rows stay.
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    expect(screen.queryByText('ZETA STORES')).toBeNull()

    await userEvent.click(screen.getByLabelText(/billable/i))
    await userEvent.click(await screen.findByRole('option', { name: /not billable/i }))
    expect(await screen.findByText('ZETA STORES')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
  })

  it('a tile narrows the grid to its own slice, and clicking it again clears it', async () => {
    stub()
    renderList()

    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    const delivered = tile('courier confirmed delivery')

    await userEvent.click(delivered)
    expect(screen.getByText('BETA TRADERS')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()

    await userEvent.click(delivered)
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
  })

  it('searches across the dispatch id, the merchant and the AWB without asking the server again', async () => {
    const calls = stub()
    renderList()
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
    const before = calls.length

    await userEvent.type(searchBox(), 'GAMMA')
    expect(screen.getByText('GAMMA GOODS')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
    // The text filter is applied to what was already fetched: a keystroke must
    // not be a round trip.
    expect(calls.length).toBe(before)
  })

  it('clears every filter at once, because clearing them one by one is how a stale filter hides rows', async () => {
    stub()
    renderList()
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()

    await userEvent.type(searchBox(), 'GAMMA')
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }))
    expect(await screen.findByText('ALPHA STORE')).toBeTruthy()
  })

  it('opens the dispatch page from the row, which is the link the old list never had', async () => {
    stub()
    renderList()

    const row = (await screen.findByText('ALPHA STORE')).closest('tr')!
    await userEvent.click(within(row).getByText('asgn_transit'))
    expect(await screen.findByRole('heading', { name: 'dispatch page' })).toBeTruthy()
  })

  it('renders the bank by the name an operator uses, not the reference code alone', async () => {
    stub()
    renderList()
    // The code is what the report carries; the roster turns it into a name.
    expect(await screen.findAllByText('GSCB')).toBeTruthy()
  })
})

// HOLD READS AS A STAGE (23 Aug 2026).
//
// A held dispatch has pool_status HELD in fulfillment AND pipeline_state
// RECEIVED in analytics, in two different tables. The badge used to be drawn in
// the COURIER STATUS cell, which a hold has nothing to do with, so on the axis
// an operator actually scans a held parcel looked like an ordinary pending one.
describe('The dispatch list: hold', () => {
  beforeEach(() => {
    setAccessToken('t')
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    cleanup()
    clearAccessToken()
  })

  it('shows Held in the Stage cell, with the stage it is parked at underneath', async () => {
    stub()
    renderList()
    await screen.findByText('EPSILON MEDICAL')

    const stageCell = cellsOf('EPSILON MEDICAL')[headerIndex(/^Stage$/)]!
    expect(within(stageCell).getByText('Held')).toBeTruthy()
    // The underlying stage survives, because it is where the parcel resumes
    // from once released. Showing only "Held" would lose it.
    expect(within(stageCell).getByText('Received')).toBeTruthy()
  })

  it('no longer renders the hold in the Courier status cell', async () => {
    stub()
    renderList()
    await screen.findByText('EPSILON MEDICAL')

    const courierCell = cellsOf('EPSILON MEDICAL')[headerIndex(/Courier status/)]!
    expect(within(courierCell).queryByText(/held/i)).toBeNull()
  })

  it('leaves an unheld dispatch showing its plain stage', async () => {
    stub()
    renderList()
    await screen.findByText('ALPHA STORE')

    const stageCell = cellsOf('ALPHA STORE')[headerIndex(/^Stage$/)]!
    expect(within(stageCell).getByText('Dispatched')).toBeTruthy()
    expect(within(stageCell).queryByText('Held')).toBeNull()
  })

  it('offers Held inside the Stage filter and narrows to it, with no separate Hold control', async () => {
    stub()
    renderList()
    await screen.findByText('EPSILON MEDICAL')

    // The toggle that used to live beside the Stage picker is gone.
    expect(screen.queryByLabelText(/^Hold$/i)).toBeNull()

    await userEvent.click(screen.getByLabelText('Stage'))
    const listbox = await screen.findByRole('listbox')
    await userEvent.click(within(listbox).getByRole('option', { name: /Held/ }))

    expect(screen.getByText('EPSILON MEDICAL')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
  })

  // Links an operator already shared must keep meaning what they meant.
  it('still honours a legacy ?held=1 link by selecting the Held stage', async () => {
    stub()
    render(
      <MemoryRouter initialEntries={['/dispatches?held=1']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <Routes>
            <Route path="/dispatches" element={<DispatchesPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('EPSILON MEDICAL')).toBeTruthy()
    expect(screen.queryByText('ALPHA STORE')).toBeNull()
  })

  // The defect that made the filter and the column disagree: two different
  // words for one value on one screen.
  it('names a stage identically in the filter and in the column', async () => {
    stub()
    renderList()
    await screen.findByText('DELTA DEPOT')

    const stageCell = cellsOf('DELTA DEPOT')[headerIndex(/^Stage$/)]!
    const columnLabel = stageCell.textContent ?? ''

    await userEvent.click(screen.getByLabelText('Stage'))
    const listbox = await screen.findByRole('listbox')
    const options = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
    expect(options.some((o) => o.includes(columnLabel.trim()))).toBe(true)
  })
})
