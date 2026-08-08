import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EntityPicker } from '../../src/components/EntityPicker.js'

// Redesign step 2. The one component that stops "never ask for an identifier the
// operator must remember" from decaying back into a text box.
//
// The contract it has to hold: the operator searches for a thing by what they
// CALL it, and the caller receives the wire id. The id is displayed, copyable,
// and never typed.
afterEach(() => { cleanup() })

interface Pool {
  tenantWire: string
  bankName: string
  city: string
  pending: number
}

const POOLS: Pool[] = [
  { tenantWire: 'tnnt_50000000008008000000000001', bankName: 'GSCB', city: 'Ahmedabad', pending: 360 },
  { tenantWire: 'tnnt_50000000008008000000000002', bankName: 'Rajkot Nagarik', city: 'Rajkot', pending: 12 },
]

function toOption(p: Pool) {
  return { id: p.tenantWire, primary: p.bankName, secondary: p.city, meta: `${p.pending} pending` }
}

function renderPicker(over: Partial<Parameters<typeof EntityPicker<Pool>>[0]> = {}) {
  const onSelect = vi.fn()
  render(
    <EntityPicker<Pool>
      label="Pending pool"
      fetchItems={async () => POOLS}
      toOption={toOption}
      onSelect={onSelect}
      emptyText="No pending pools."
      {...over}
    />,
  )
  return { onSelect }
}

describe('EntityPicker', () => {
  it('lists entities by the name a human calls them, not by id', async () => {
    renderPicker()
    expect(await screen.findByText('GSCB')).toBeTruthy()
    expect(screen.getByText('Rajkot Nagarik')).toBeTruthy()
  })

  it('shows the disambiguating context, so two similar names can be told apart', async () => {
    renderPicker()
    expect(await screen.findByText('Ahmedabad')).toBeTruthy()
    expect(screen.getByText('360 pending')).toBeTruthy()
  })

  it('hands the caller the WIRE ID when an entity is picked', async () => {
    const { onSelect } = renderPicker()
    await userEvent.click(await screen.findByRole('button', { name: /GSCB/ }))
    expect(onSelect).toHaveBeenCalledWith('tnnt_50000000008008000000000001', POOLS[0])
  })

  it('filters as the operator types, matching on name and on context', async () => {
    renderPicker()
    await screen.findByText('GSCB')
    await userEvent.type(screen.getByRole('searchbox', { name: /pending pool/i }), 'rajkot')
    expect(screen.getByText('Rajkot Nagarik')).toBeTruthy()
    expect(screen.queryByText('GSCB')).toBeNull()
  })

  it('says so when there is nothing to pick, rather than rendering an empty box', async () => {
    renderPicker({ fetchItems: async () => [] })
    expect(await screen.findByText('No pending pools.')).toBeTruthy()
  })

  it('tells the operator when the search matched nothing, distinct from having no entities', async () => {
    renderPicker()
    await screen.findByText('GSCB')
    await userEvent.type(screen.getByRole('searchbox', { name: /pending pool/i }), 'zzzz')
    expect(screen.getByText(/no match/i)).toBeTruthy()
    expect(screen.queryByText('No pending pools.')).toBeNull()
  })

  // The load-bearing one. A picker that degrades to a text box on failure would
  // quietly restore the exact problem this component exists to remove.
  it('surfaces a load failure WITHOUT offering a free-text id fallback', async () => {
    renderPicker({ fetchItems: async () => { throw new Error('edge is down') } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('shows the picked entity id as copyable context, never as an input', async () => {
    renderPicker({ selectedId: 'tnnt_50000000008008000000000001' })
    const selected = await screen.findByTestId('entity-picker-selected')
    expect(within(selected).getByText('tnnt_50000000008008000000000001')).toBeTruthy()
    expect(within(selected).queryByRole('textbox')).toBeNull()
  })
})
