import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { Circle } from 'lucide-react'
import { LifecycleRail, type RailStage } from '../../src/ui/LifecycleRail.js'
import { buildRailFromTrail, stageAttribution } from '../../src/ui/statusRail.js'
import type { StatusTrailEntry } from '../../src/api/endpoints.js'

// THE TICK RULE (22 Aug 2026, the meeting complaint). A batch the operator had
// just sent to the print vendor rendered that stage WITHOUT the green tick,
// because the old rail ticked only stages BEHIND the current one. The customer
// read "no tick" as "not done" on the very action they had just performed.
// Done is done: every stage that has happened is ticked, the newest included,
// and only the stages still AHEAD look disabled.

const icon = Circle

function stage(partial: Partial<RailStage> & { key: string; state: RailStage['state'] }): RailStage {
  return { label: partial.key, icon, ...partial }
}

function entry(partial: Partial<StatusTrailEntry> & { status: string }): StatusTrailEntry {
  return {
    occurredAt: '2026-08-22T09:00:00.000Z',
    statusSource: 'courier-file',
    actorId: null,
    actorDisplay: null,
    recordedAt: '2026-08-22T09:00:01.000Z',
    ...partial,
  }
}

describe('LifecycleRail tick semantics', () => {
  afterEach(() => cleanup())

  it('ticks every done stage INCLUDING the newest one, and never a future stage', () => {
    render(
      <LifecycleRail
        stages={[
          stage({ key: 'BATCHED', state: 'reached' }),
          stage({ key: 'SENT_TO_PRINT_VENDOR', state: 'current' }),
          stage({ key: 'CLOSED', state: 'future' }),
        ]}
      />,
    )
    const rail = screen.getByRole('list', { name: 'Lifecycle rail' })
    // Two ticks: the passed stage AND the stage just performed. The old
    // rendering produced one, which is the exact defect this pins.
    expect(within(rail).getAllByTestId('stage-tick')).toHaveLength(2)
    const items = within(rail).getAllByRole('listitem')
    // The future stage carries no tick.
    const future = items.find((li) => li.textContent?.includes('CLOSED'))
    expect(future).toBeTruthy()
    expect(within(future!).queryByTestId('stage-tick')).toBeNull()
  })

  it('a terminal stage is never ticked: red is an outcome, not a completion', () => {
    render(
      <LifecycleRail
        stages={[
          stage({ key: 'DISPATCHED', state: 'reached' }),
          stage({ key: 'DAMAGED', state: 'current', terminal: true }),
        ]}
      />,
    )
    expect(screen.getAllByTestId('stage-tick')).toHaveLength(1)
  })

  it('renders the who-did-it line only when given one, like the timestamp', () => {
    render(
      <LifecycleRail
        stages={[
          stage({ key: 'HELD', state: 'reached', by: 'ops.admin' }),
          stage({ key: 'POOLED', state: 'current' }),
        ]}
      />,
    )
    expect(screen.getByText('ops.admin')).toBeTruthy()
  })
})

describe('buildRailFromTrail attribution', () => {
  it('prefers the operator handle, falls back to the channel, and stays silent on backfill', () => {
    expect(stageAttribution({ actorDisplay: 'ops.admin', statusSource: 'ops:release-hold' })).toBe('ops.admin')
    expect(stageAttribution({ actorDisplay: null, statusSource: 'courier-file' })).toBe('Courier file')
    expect(stageAttribution({ actorDisplay: null, statusSource: 'backfill' })).toBeNull()
  })

  it('threads by onto the stages it derives from the trail', () => {
    const stages = buildRailFromTrail({
      spine: ['IN_STOCK', 'PRINTED', 'DISPATCHED', 'DELIVERED'],
      terminals: ['DAMAGED', 'RETURNED'],
      trail: [
        entry({ status: 'IN_STOCK', statusSource: 'intake' }),
        entry({ status: 'PRINTED', statusSource: 'ops:correct-unit-status', actorDisplay: 'ops.admin' }),
      ],
      label: (s) => s,
      icon: () => icon,
    })
    const printed = stages.find((s) => s.key === 'PRINTED')
    expect(printed?.by).toBe('ops.admin')
    expect(printed?.state).toBe('current')
    const inStock = stages.find((s) => s.key === 'IN_STOCK')
    expect(inStock?.by).toBe('Manufacturer intake')
    // Ahead stages carry neither a time nor an attribution.
    const delivered = stages.find((s) => s.key === 'DELIVERED')
    expect(delivered?.state).toBe('future')
    expect(delivered?.by).toBeUndefined()
  })

  it('ends the rail at a terminal, with the terminal attributed', () => {
    const stages = buildRailFromTrail({
      spine: ['IN_STOCK', 'PRINTED', 'DISPATCHED', 'DELIVERED'],
      terminals: ['DAMAGED'],
      trail: [
        entry({ status: 'DISPATCHED' }),
        entry({ status: 'DAMAGED', statusSource: 'replacement-raised' }),
      ],
      label: (s) => s,
      icon: () => icon,
    })
    expect(stages.at(-1)).toMatchObject({ key: 'DAMAGED', terminal: true, by: 'Damage flag' })
    // Nothing after the terminal: DELIVERED is not drawn at all.
    expect(stages.some((s) => s.key === 'DELIVERED')).toBe(false)
  })
})
