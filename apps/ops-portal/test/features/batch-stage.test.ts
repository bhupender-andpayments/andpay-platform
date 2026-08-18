import { describe, expect, it } from 'vitest'
import { deriveBatchStage, stagePill, stageSortRank } from '../../src/features/fulfillment/batchStage.js'

// Controller ruling (2026-08-18): Task 1 never projects REQUEST_SENT_TO_CWD, so
// the wire's activation.requested is always null. The brief's contingency for
// that case applies: READY_FOR_CWD and AWAITING_ACTIVATION collapse into one
// ACTIVATION stage, here and in stagePill. The brief's two split test cases are
// rewritten below as ACTIVATION cases; every other case is kept as written.
const base = {
  batchId: 'btch_x',
  counts: { total: 4, deliverableAndActivatable: 2, sentToVendor: 4, dispatched: 4, delivered: 4, activated: 2 },
  activation: { notRequested: null, requested: null, activated: 2 },
}

describe('deriveBatchStage', () => {
  it('is PRINTING while any dispatch lacks the return sheet', () => {
    const s = deriveBatchStage({ ...base, counts: { ...base.counts, dispatched: 1 } })
    expect(s).toMatchObject({ stage: 'PRINTING', done: 1, of: 4, needsAction: true })
  })

  it('is SHIPPING while couriers are in flight', () => {
    const s = deriveBatchStage({ ...base, counts: { ...base.counts, delivered: 2 } })
    expect(s.stage).toBe('SHIPPING')
    expect(s.needsAction).toBe(false)
  })

  it('is ACTIVATION once delivered soundboxes still need activating (collapsed READY_FOR_CWD case)', () => {
    const s = deriveBatchStage({ ...base, counts: { ...base.counts, activated: 0 }, activation: { notRequested: null, requested: null, activated: 0 } })
    expect(s).toMatchObject({ stage: 'ACTIVATION', needsAction: true, done: 0, of: 2 })
  })

  it('is ACTIVATION once the request went to CWD (collapsed AWAITING_ACTIVATION case)', () => {
    const s = deriveBatchStage({ ...base, counts: { ...base.counts, activated: 0 }, activation: { notRequested: null, requested: null, activated: 0 } })
    expect(s.stage).toBe('ACTIVATION')
  })

  it('is COMPLETE when everything activatable is activated', () => {
    expect(deriveBatchStage(base).stage).toBe('COMPLETE')
  })

  it('is COMPLETE for a collateral-only batch once delivered', () => {
    const s = deriveBatchStage({
      ...base,
      counts: { ...base.counts, deliverableAndActivatable: 0, activated: 0 },
      activation: { notRequested: null, requested: null, activated: 0 },
    })
    expect(s.stage).toBe('COMPLETE')
  })
})

describe('stagePill', () => {
  it('maps every stage to its label and variant', () => {
    expect(stagePill('PRINTING')).toEqual({ label: 'Needs return sheet', variant: 'pending' })
    expect(stagePill('SHIPPING')).toEqual({ label: 'Shipping', variant: 'info' })
    expect(stagePill('ACTIVATION')).toEqual({ label: 'Awaiting activation', variant: 'pending' })
    expect(stagePill('COMPLETE')).toEqual({ label: 'Complete', variant: 'positive' })
  })
})

describe('stageSortRank', () => {
  it('orders PRINTING, ACTIVATION, SHIPPING, COMPLETE, then undefined last', () => {
    expect(stageSortRank(deriveBatchStage({ ...base, counts: { ...base.counts, dispatched: 1 } }))).toBe(0)
    expect(
      stageSortRank(
        deriveBatchStage({ ...base, counts: { ...base.counts, activated: 0 }, activation: { notRequested: null, requested: null, activated: 0 } }),
      ),
    ).toBe(1)
    expect(stageSortRank(deriveBatchStage({ ...base, counts: { ...base.counts, delivered: 2 } }))).toBe(2)
    expect(stageSortRank(deriveBatchStage(base))).toBe(3)
    expect(stageSortRank(undefined)).toBe(4)
  })
})
