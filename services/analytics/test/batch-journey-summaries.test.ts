import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../generated/client/index.js'
import { readBatchJourneySummaries } from '../src/mediation.js'

const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => { await db.$disconnect() })

const BATCH_A = `btch_${randomUUID().replace(/-/g, '')}`
const BATCH_B = `btch_${randomUUID().replace(/-/g, '')}`
const BATCH_C = `btch_${randomUUID().replace(/-/g, '')}`
let progA = ''

// The OLD JS classification, reimplemented here rather than imported (the
// mediation module does not export JOURNEY_RANK/atLeast/isSoundboxOrLegacy/
// isActivated), so the agreement test below proves the SQL FILTER predicates
// in scopedBatchJourneySummaryRead classify the SAME rows the JS version did,
// not merely a lookalike. Kept byte-for-byte in shape with
// services/analytics/src/mediation.ts's own copies.
const JOURNEY_RANK: Record<string, number> = {
  RECEIVED: 1,
  BATCHED: 2,
  SENT_TO_VENDOR: 3,
  DISPATCHED: 4,
  DELIVERED: 5,
}
function atLeast(state: string, floor: string): boolean {
  return (JOURNEY_RANK[state] ?? 0) >= (JOURNEY_RANK[floor] ?? 0)
}
function isSoundboxOrLegacy(dispatchGroup: string | null): boolean {
  return dispatchGroup === null || dispatchGroup === 'SOUNDBOX'
}
function isActivated(activationStatus: string | null): boolean {
  return activationStatus === 'ACTIVATED'
}

// Mirrors insertRow in batch-journey.test.ts, the readBatchJourney fixture.
async function insertRow(args: {
  dispatchId: string
  programId: string
  batchId: string | null
  pipelineState: string
  courierStatus?: string | null
  deliveryDate?: Date | null
  activationStatus?: string | null
  awb?: string | null
  dispatchGroup?: string | null
  sentToVendorAt?: Date | null
}): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       batch_id, pipeline_state, courier_status, delivery_date, activation_status,
       awb, dispatch_group, sent_to_vendor_at, billable_flag, received_at, updated_at)
    VALUES (${args.dispatchId}, ${args.programId}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
            ${args.batchId}, ${args.pipelineState}, ${args.courierStatus ?? null},
            ${args.deliveryDate ?? null}, ${args.activationStatus ?? null},
            ${args.awb ?? null}, ${args.dispatchGroup ?? null}, ${args.sentToVendorAt ?? null},
            true, now(), now())`
}

describe('readBatchJourneySummaries', () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark CASCADE')
    progA = randomUUID()
    await db.$executeRaw`
      INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
      VALUES ('fct.assignment.v1', ${new Date('2026-08-11T09:00:00.000Z')}, 'env-1', now())`
  })

  it('groups rollups per batch, excludes batchless rows, and matches JOURNEY_RANK cumulatively', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH_A, pipelineState: 'DISPATCHED', dispatchGroup: 'SOUNDBOX' })
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH_A, pipelineState: 'SENT_TO_VENDOR', dispatchGroup: 'COLLATERAL' })
    await insertRow({
      dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH_B, pipelineState: 'DELIVERED',
      dispatchGroup: 'SOUNDBOX', deliveryDate: new Date('2026-08-10T10:00:00.000Z'), activationStatus: 'ACTIVATED',
    })
    // Batchless: must not leak into any rollup, and must not appear as its own row.
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: null, pipelineState: 'RECEIVED' })

    const view = await readBatchJourneySummaries(db)
    expect(view.rows.map((r) => r.batchId).sort()).toEqual([BATCH_A, BATCH_B].sort())

    const a = view.rows.find((r) => r.batchId === BATCH_A)!
    // Cumulative off JOURNEY_RANK: the DISPATCHED row also counts as sentToVendor.
    expect(a.counts).toMatchObject({ total: 2, sentToVendor: 2, dispatched: 1, delivered: 0, activated: 0 })

    const b = view.rows.find((r) => r.batchId === BATCH_B)!
    expect(b.counts).toMatchObject({ total: 1, sentToVendor: 1, dispatched: 1, delivered: 1, activated: 1 })
    expect(b.activation.activated).toBe(1)

    expect(view.watermark).toBeTruthy()
    expect(view.watermark.asOf).toBe('2026-08-11T09:00:00.000Z')
  })

  // dispatch_row.activation_status is written only as NULL or 'ACTIVATED'
  // (services/analytics/src/project.ts, T.ACTIVATED case); nothing ever writes
  // REQUEST_SENT_TO_CWD. So the requested/notRequested split cannot be computed
  // from this projection and must read as null, not as a fabricated zero.
  it('reports activation.requested and notRequested as null: the projection carries no REQUEST_SENT_TO_CWD split', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH_A, pipelineState: 'DELIVERED', dispatchGroup: 'SOUNDBOX' })

    const view = await readBatchJourneySummaries(db)
    const a = view.rows.find((r) => r.batchId === BATCH_A)!
    expect(a.activation.notRequested).toBeNull()
    expect(a.activation.requested).toBeNull()
  })

  it('excludes a batch with only batchless rows from the result set', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: null, pipelineState: 'RECEIVED' })
    const view = await readBatchJourneySummaries(db)
    expect(view.rows).toHaveLength(0)
  })

  // Agreement test: proves the SQL FILTER predicates in
  // scopedBatchJourneySummaryRead classify EXACTLY the rows the old JS
  // classifiers (JOURNEY_RANK/atLeast, isSoundboxOrLegacy, isActivated) did.
  // Seeds one batch spanning every journey stage plus a legacy row, a
  // SOUNDBOX row and a COLLATERAL row, computes the expected rollup by
  // running the reimplemented JS classifiers over the same fixture, and
  // asserts the SQL result matches that expectation field by field.
  it('agrees with the old JS classification across every journey stage, soundbox, legacy and collateral rows', async () => {
    const fixture: { pipelineState: string; dispatchGroup: string | null; activationStatus: string | null }[] = [
      { pipelineState: 'RECEIVED', dispatchGroup: 'SOUNDBOX', activationStatus: null },
      { pipelineState: 'BATCHED', dispatchGroup: 'SOUNDBOX', activationStatus: null },
      { pipelineState: 'SENT_TO_VENDOR', dispatchGroup: 'SOUNDBOX', activationStatus: null },
      { pipelineState: 'DISPATCHED', dispatchGroup: 'SOUNDBOX', activationStatus: null },
      { pipelineState: 'DELIVERED', dispatchGroup: 'SOUNDBOX', activationStatus: 'ACTIVATED' },
      // Legacy (pre-split, no dispatch_group): counts toward deliverableAndActivatable too.
      { pipelineState: 'DELIVERED', dispatchGroup: null, activationStatus: 'ACTIVATED' },
      // COLLATERAL: ships and delivers like everything else, but must never
      // count toward deliverableAndActivatable or activated.
      { pipelineState: 'SENT_TO_VENDOR', dispatchGroup: 'COLLATERAL', activationStatus: null },
      { pipelineState: 'DELIVERED', dispatchGroup: 'COLLATERAL', activationStatus: null },
    ]

    for (const row of fixture) {
      await insertRow({
        dispatchId: `asgn_${randomUUID()}`,
        programId: progA,
        batchId: BATCH_C,
        pipelineState: row.pipelineState,
        dispatchGroup: row.dispatchGroup,
        activationStatus: row.activationStatus,
      })
    }

    const expected = fixture.reduce(
      (acc, row) => {
        acc.total += 1
        if (isSoundboxOrLegacy(row.dispatchGroup)) acc.deliverableAndActivatable += 1
        if (atLeast(row.pipelineState, 'SENT_TO_VENDOR')) acc.sentToVendor += 1
        if (atLeast(row.pipelineState, 'DISPATCHED')) acc.dispatched += 1
        if (atLeast(row.pipelineState, 'DELIVERED')) acc.delivered += 1
        if (isActivated(row.activationStatus)) acc.activated += 1
        return acc
      },
      { total: 0, deliverableAndActivatable: 0, sentToVendor: 0, dispatched: 0, delivered: 0, activated: 0 },
    )

    const view = await readBatchJourneySummaries(db)
    const c = view.rows.find((r) => r.batchId === BATCH_C)!
    expect(c.counts).toEqual(expected)
    expect(c.activation.activated).toBe(expected.activated)
    expect(c.activation.notRequested).toBeNull()
    expect(c.activation.requested).toBeNull()
  })
})
