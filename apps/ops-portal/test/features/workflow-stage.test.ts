import { describe, it, expect } from 'vitest'
import { deriveWorkflow, type WorkflowSnapshot } from '../../src/features/workflow/workflowStage.js'
import type { BatchJourneyView } from '../../src/api/endpoints.js'

// Pure derivation, no DOM. This is the module that decides what the rail claims,
// so every honesty rule from the spec's section 4.3 is pinned here rather than
// through a rendered screen.

function journey(over: Partial<BatchJourneyView> = {}): BatchJourneyView {
  return {
    batchId: 'btch_1',
    counts: { total: 10, sentToVendor: 0, dispatched: 0, delivered: 0, activated: 0 },
    courier: { pickedUp: 0, inTransit: 0, outForDelivery: 0, delivered: 0, exception: 0 },
    activation: { awaiting: 0, activated: 0, failed: 0, simActivated: null },
    awaitingActivation: [],
    watermark: { asOf: null, perTopic: {} },
    ...over,
  }
}

function batchMode(over: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    mode: 'batch',
    pools: [],
    batchDetail: {
      batch: {
        id: 'btch_1', status: 'FORMED', triggerReason: 'LOT_SIZE', unitCount: 10,
        printVndr: 'vndr_1', triggeredByActor: null, triggerNote: null,
        createdAt: '2026-08-11T09:00:00.000Z', updatedAt: '2026-08-11T09:00:00.000Z',
      },
      entries: [],
      artifacts: [],
      printLayout: 'ONE_PER_PAGE',
    },
    journey: journey(),
    hasPreview: false,
    hasCommitted: false,
    commitAwaitingPool: false,
    elapsedMsInStage: 0,
    ...over,
  }
}

describe('deriveWorkflow: honesty rule 1, stages 1 and 2 are complete-by-definition in batch mode', () => {
  it('marks Upload and Validate complete for any batch, because the requests exist', () => {
    const d = deriveWorkflow(batchMode())
    expect(d.completed).toContain('upload')
    expect(d.completed).toContain('validate')
  })

  // A batch cannot be traced back to the files that fed it: pending_pool_entry
  // holds no file_id. So the stages carry the checkmark and NO detail. A count
  // here would be an invented claim about which file this batch came from.
  it('claims no file detail for those two stages', () => {
    const d = deriveWorkflow(batchMode())
    expect(d.facts.fileTraceable).toBe(false)
  })

  it('in pool mode they are NOT complete-by-definition: they are the live work', () => {
    const d = deriveWorkflow({ ...batchMode(), mode: 'pool', batchDetail: null, journey: null })
    expect(d.completed).not.toContain('upload')
    expect(d.current).toBe('upload')
  })
})

describe('deriveWorkflow: honesty rule 2, current is the LOWEST incomplete stage', () => {
  it('a freshly formed batch with no artifacts sits at Generate', () => {
    const d = deriveWorkflow(batchMode())
    expect(d.current).toBe('generate')
    expect(d.completed).toContain('batch')
  })

  it('artifacts present but nothing dispatched sits at Print', () => {
    const d = deriveWorkflow(
      batchMode({
        batchDetail: {
          ...batchMode().batchDetail!,
          artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
        },
        journey: journey({ counts: { total: 10, sentToVendor: 10, dispatched: 0, delivered: 0, activated: 0 } }),
      }),
    )
    expect(d.current).toBe('print')
    expect(d.completed).toContain('generate')
  })

  // The heart of the rule. 10 records: 9 delivered, 1 still in transit. Delivery
  // is NOT complete, so it is current, even though activation already has work.
  it('holds at Delivery while ANY record is still moving, and shows the fan-out there', () => {
    const d = deriveWorkflow(
      batchMode({
        batchDetail: {
          ...batchMode().batchDetail!,
          artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
        },
        journey: journey({
          counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 9, activated: 2 },
          courier: { pickedUp: 0, inTransit: 1, outForDelivery: 0, delivered: 9, exception: 0 },
        }),
      }),
    )
    expect(d.current).toBe('delivery')
    // Not a single status for the batch. A spread.
    expect(d.facts.courier).toEqual({ pickedUp: 0, inTransit: 1, outForDelivery: 0, delivered: 9, exception: 0 })
    // And activation is genuinely complete for nobody yet, so it is not marked.
    expect(d.completed).not.toContain('activation')
  })

  it('reaches Activation only once every record is delivered', () => {
    const d = deriveWorkflow(
      batchMode({
        batchDetail: {
          ...batchMode().batchDetail!,
          artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
        },
        journey: journey({
          counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 10, activated: 3 },
          activation: { awaiting: 7, activated: 3, failed: 0, simActivated: null },
        }),
      }),
    )
    expect(d.current).toBe('activation')
    expect(d.completed).toContain('delivery')
  })

  it('is complete only when every record is activated', () => {
    const d = deriveWorkflow(
      batchMode({
        batchDetail: {
          ...batchMode().batchDetail!,
          artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
        },
        journey: journey({
          counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 10, activated: 10 },
          activation: { awaiting: 0, activated: 10, failed: 0, simActivated: null },
        }),
      }),
    )
    expect(d.completed).toContain('activation')
    expect(d.isComplete).toBe(true)
  })
})

describe('deriveWorkflow: honesty rule 3, a stage with no backing read says so', () => {
  it('reports simActivated as unavailable, never as zero', () => {
    const d = deriveWorkflow(batchMode())
    expect(d.facts.simActivationAvailable).toBe(false)
  })

  it('reports the journey as unavailable when the read has not landed, rather than showing zeros', () => {
    const d = deriveWorkflow(batchMode({ journey: null }))
    expect(d.facts.journeyAvailable).toBe(false)
    // With no journey there is nothing to claim past Generate, so it must not
    // advance into stages it cannot see.
    expect(d.current).toBe('generate')
  })

  it('echoes the elapsed time through so a stage never has to read the clock itself', () => {
    const d = deriveWorkflow(batchMode({ elapsedMsInStage: 6000 }))
    expect(d.facts.elapsedMsInStage).toBe(6000)
  })

  it('carries the analytics watermark through, and null when there is no journey to badge', () => {
    const withJourney = deriveWorkflow(batchMode({ journey: journey({ watermark: { asOf: '2026-08-11T09:00:00.000Z', perTopic: {} } }) }))
    expect(withJourney.facts.watermark?.asOf).toBe('2026-08-11T09:00:00.000Z')
    expect(deriveWorkflow(batchMode({ journey: null })).facts.watermark).toBeNull()
  })

  // The stage-8 worklist has to travel through here. The Activation stage cannot
  // fetch it (it renders from props) and cannot rebuild it from batchDetail.entries,
  // which carry no delivery_date and no awb; rebuilding would also drop the
  // soundbox-or-legacy gate readBatchJourney applies, putting a delivered standee
  // on a worklist whose write would 409 it.
  it('forwards the awaiting-activation worklist, and an EMPTY ARRAY rather than undefined with no journey', () => {
    const rows = [{ dispatchId: 'asgn_a', merchantDisplay: 'Acme', awb: 'AWB1', deliveryDate: '2026-08-10T10:00:00.000Z' }]
    const withJourney = deriveWorkflow(batchMode({ journey: journey({ awaitingActivation: rows }) }))
    expect(withJourney.facts.awaitingActivation).toEqual(rows)

    // Never undefined and never null on any path, so a consumer maps over it
    // unconditionally instead of guarding at every call site.
    expect(deriveWorkflow(batchMode({ journey: null })).facts.awaitingActivation).toEqual([])
    expect(deriveWorkflow({ ...batchMode(), mode: 'pool' }).facts.awaitingActivation).toEqual([])
  })

  // Reachable: batchDetail and journey are independent reads, and the analytics
  // projection folds the batch fact asynchronously, so composed artifacts
  // routinely exist before the journey row does. The old clamp made `generate`
  // both complete and current here, which is the one thing rule 2 forbids.
  it('never reports a stage as current AND complete, with artifacts present but no journey yet', () => {
    const detail = {
      ...batchMode().batchDetail!,
      artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
    }
    const d = deriveWorkflow(batchMode({ batchDetail: detail, journey: null }))
    expect(d.completed).toContain('generate')
    expect(d.current).toBe('print')
    expect(d.completed).not.toContain(d.current)
    // The honesty signal, not the stage number, is what tells Print it cannot
    // speak about courier or activation data.
    expect(d.facts.journeyAvailable).toBe(false)
  })
})

describe('deriveWorkflow: the Generate hang state', () => {
  it('does not cry hang before the threshold', () => {
    const d = deriveWorkflow(batchMode({ elapsedMsInStage: 10_000 }))
    expect(d.facts.generateStalled).toBe(false)
  })

  it('flags a stall past 90 seconds with no artifacts, so the screen stops pretending', () => {
    const d = deriveWorkflow(batchMode({ elapsedMsInStage: 91_000 }))
    expect(d.facts.generateStalled).toBe(true)
  })

  it('never flags a stall once artifacts exist, however long it took', () => {
    const d = deriveWorkflow(
      batchMode({
        elapsedMsInStage: 600_000,
        batchDetail: {
          ...batchMode().batchDetail!,
          artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
        },
      }),
    )
    expect(d.facts.generateStalled).toBe(false)
  })
})

describe('deriveWorkflow: the poll speed follows who is being waited on', () => {
  it('polls fast while the MACHINE is working', () => {
    expect(deriveWorkflow(batchMode()).pollSpeed).toBe('fast')
  })

  it('polls slow while a HUMAN is being waited on', () => {
    const d = deriveWorkflow({ ...batchMode(), mode: 'pool', batchDetail: null, journey: null })
    expect(d.pollSpeed).toBe('slow')
  })

  // The one window where pool mode is NOT waiting on a person, and it is on the
  // primary flow. A commit writes fct.tms.bank_file_row.v1 to the TMS outbox and
  // the records are pooled only once the relay has published it and the
  // fulfillment consumer has folded it, so between the commit and the pool
  // showing them the screen is waiting on the machine. At the slow cadence the
  // rail took up to thirty seconds to move.
  it('polls FAST in pool mode while a commit is still waiting on the pool', () => {
    const d = deriveWorkflow({
      ...batchMode(),
      mode: 'pool',
      batchDetail: null,
      journey: null,
      hasPreview: true,
      // The commit landed; no pool read has shown its records yet, so hasCommitted
      // is still false. That gap is the whole point.
      hasCommitted: false,
      commitAwaitingPool: true,
    })
    expect(d.pollSpeed).toBe('fast')
    // And the rail has NOT moved for it: only a pool read may do that.
    expect(d.current).toBe('validate')
  })

  it('returns to slow in pool mode once the pool has confirmed the commit', () => {
    const d = deriveWorkflow({
      ...batchMode(),
      mode: 'pool',
      batchDetail: null,
      journey: null,
      hasPreview: true,
      hasCommitted: true,
      commitAwaitingPool: false,
    })
    expect(d.current).toBe('batch')
    // Batching a pool early is a person's decision, so there is nothing left to
    // watch at three-second intervals.
    expect(d.pollSpeed).toBe('slow')
  })

  it('stops polling once the batch is complete', () => {
    const d = deriveWorkflow(
      batchMode({
        batchDetail: {
          ...batchMode().batchDetail!,
          artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
        },
        journey: journey({
          counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 10, activated: 10 },
          activation: { awaiting: 0, activated: 10, failed: 0, simActivated: null },
        }),
      }),
    )
    expect(d.pollSpeed).toBe('off')
  })
})

describe('deriveWorkflow: pool mode advances with the flow, never with a Next button', () => {
  it('a preview moves Upload to Validate', () => {
    const d = deriveWorkflow({ ...batchMode(), mode: 'pool', batchDetail: null, journey: null, hasPreview: true })
    expect(d.current).toBe('validate')
    expect(d.completed).toContain('upload')
  })

  it('a commit moves Validate to Batch', () => {
    const d = deriveWorkflow({
      ...batchMode(), mode: 'pool', batchDetail: null, journey: null,
      hasPreview: true, hasCommitted: true,
    })
    expect(d.current).toBe('batch')
    expect(d.completed).toContain('validate')
  })
})

// The general form of the rule 2 invariant that the clamp bug violated: across
// every shape this fixture set can produce, `current` is never one of the
// stages already in `completed`, unless the whole workflow is done. Modeled
// on env.test.ts's closing "never returns an empty string, whatever it is
// handed" test: one targeted example earns its own `it`, and the sweep across
// fixtures is the belt-and-suspenders check that nothing else was missed.
describe('deriveWorkflow: current is never also complete, across every fixture shape', () => {
  const withArtifact = {
    ...batchMode().batchDetail!,
    artifacts: [{ asgnId: 'asgn_1', artifactType: 'SOUNDBOX_IMG', assetReference: 'ref', supersededAt: null }],
  }

  const snapshots: WorkflowSnapshot[] = [
    batchMode(),
    batchMode({ journey: null }),
    batchMode({ batchDetail: withArtifact, journey: null }),
    batchMode({ batchDetail: withArtifact, journey: journey({ counts: { total: 10, sentToVendor: 10, dispatched: 0, delivered: 0, activated: 0 } }) }),
    batchMode({
      batchDetail: withArtifact,
      journey: journey({
        counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 9, activated: 2 },
        courier: { pickedUp: 0, inTransit: 1, outForDelivery: 0, delivered: 9, exception: 0 },
      }),
    }),
    batchMode({
      batchDetail: withArtifact,
      journey: journey({
        counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 10, activated: 3 },
        activation: { awaiting: 7, activated: 3, failed: 0, simActivated: null },
      }),
    }),
    batchMode({
      batchDetail: withArtifact,
      journey: journey({
        counts: { total: 10, sentToVendor: 10, dispatched: 10, delivered: 10, activated: 10 },
        activation: { awaiting: 0, activated: 10, failed: 0, simActivated: null },
      }),
    }),
    { ...batchMode(), mode: 'pool', batchDetail: null, journey: null },
    { ...batchMode(), mode: 'pool', batchDetail: null, journey: null, hasPreview: true },
    { ...batchMode(), mode: 'pool', batchDetail: null, journey: null, hasPreview: true, hasCommitted: true },
  ]

  it('holds for every fixture in this file', () => {
    for (const snapshot of snapshots) {
      const d = deriveWorkflow(snapshot)
      if (!d.isComplete) {
        expect(d.completed).not.toContain(d.current)
      }
    }
  })
})
