import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../generated/client/index.js'
import { readBatchJourney } from '../src/mediation.js'

const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => { await db.$disconnect() })

const BATCH = `btch_${randomUUID().replace(/-/g, '')}`
const OTHER_BATCH = `btch_${randomUUID().replace(/-/g, '')}`
let progA = ''
let progB = ''

async function insertRow(args: {
  dispatchId: string
  programId: string
  batchId: string | null
  pipelineState: string
  courierStatus?: string | null
  deliveryDate?: Date | null
  activationStatus?: string | null
  awb?: string | null
}): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       batch_id, pipeline_state, courier_status, delivery_date, activation_status,
       awb, billable_flag, received_at, updated_at)
    VALUES (${args.dispatchId}, ${args.programId}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
            ${args.batchId}, ${args.pipelineState}, ${args.courierStatus ?? null},
            ${args.deliveryDate ?? null}, ${args.activationStatus ?? null},
            ${args.awb ?? null}, true, now(), now())`
}

describe('readBatchJourney', () => {
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark CASCADE')
    progA = randomUUID()
    progB = randomUUID()
    await db.$executeRaw`
      INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
      VALUES ('fct.assignment.v1', ${new Date('2026-08-11T09:00:00.000Z')}, 'env-1', now())`
  })

  it('returns null for a batch with no rows, rather than an empty-but-valid view', async () => {
    const view = await readBatchJourney(db, { kind: 'crossTenant' }, BATCH)
    expect(view).toBeNull()
  })

  it('rolls up the stage counts for one batch and ignores every other batch', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'SENT_TO_VENDOR' })
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'DISPATCHED', courierStatus: 'IN_TRANSIT', awb: 'AWB1' })
    await insertRow({
      dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'DELIVERED',
      courierStatus: 'DELIVERED', deliveryDate: new Date('2026-08-10T10:00:00.000Z'), awb: 'AWB2',
    })
    await insertRow({
      dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'ACTIVATED',
      courierStatus: 'DELIVERED', deliveryDate: new Date('2026-08-10T10:00:00.000Z'), activationStatus: 'ACTIVE', awb: 'AWB3',
    })
    // A different batch, and an unbatched row: neither may leak into the rollup.
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: OTHER_BATCH, pipelineState: 'DELIVERED' })
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: null, pipelineState: 'RECEIVED' })

    const view = (await readBatchJourney(db, { kind: 'crossTenant' }, BATCH))!
    expect(view.batchId).toBe(BATCH)
    expect(view.counts.total).toBe(4)
    // Cumulative, off PIPELINE_RANK: a DELIVERED row has also been sent and dispatched.
    expect(view.counts.sentToVendor).toBe(4)
    expect(view.counts.dispatched).toBe(3)
    expect(view.counts.delivered).toBe(2)
    expect(view.counts.activated).toBe(1)
  })

  it('fans the courier statuses out rather than reporting one status for the batch', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'DISPATCHED', courierStatus: 'PICKED_UP' })
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'DISPATCHED', courierStatus: 'IN_TRANSIT' })
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'DISPATCHED', courierStatus: 'OUT_FOR_DELIVERY' })
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'DISPATCHED', courierStatus: 'RTO' })

    const view = (await readBatchJourney(db, { kind: 'crossTenant' }, BATCH))!
    expect(view.courier.pickedUp).toBe(1)
    expect(view.courier.inTransit).toBe(1)
    expect(view.courier.outForDelivery).toBe(1)
    expect(view.courier.delivered).toBe(0)
    // Anything terminal-but-not-delivered is an exception the operator must see.
    expect(view.courier.exception).toBe(1)
  })

  it('lists the delivered-but-not-activated rows so stage 8 has a worklist', async () => {
    const waiting = `asgn_${randomUUID()}`
    await insertRow({
      dispatchId: waiting, programId: progA, batchId: BATCH, pipelineState: 'DELIVERED',
      courierStatus: 'DELIVERED', deliveryDate: new Date('2026-08-10T10:00:00.000Z'), awb: 'AWB9',
    })
    await insertRow({
      dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'ACTIVATED',
      courierStatus: 'DELIVERED', deliveryDate: new Date('2026-08-10T10:00:00.000Z'), activationStatus: 'ACTIVE',
    })

    const view = (await readBatchJourney(db, { kind: 'crossTenant' }, BATCH))!
    expect(view.activation.awaiting).toBe(1)
    expect(view.activation.activated).toBe(1)
    expect(view.awaitingActivation).toHaveLength(1)
    expect(view.awaitingActivation[0]!.dispatchId).toBe(waiting)
    expect(view.awaitingActivation[0]!.awb).toBe('AWB9')
    expect(view.awaitingActivation[0]!.merchantDisplay).toBe('Acme')
  })

  it('reports simActivated as null, never 0, because no write path exists for it', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'ACTIVATED', activationStatus: 'ACTIVE' })
    const view = (await readBatchJourney(db, { kind: 'crossTenant' }, BATCH))!
    // A zero would read as "none activated their SIM". null reads as "we do not know",
    // which is the truth, and is what makes the portal render "Not available yet".
    expect(view.activation.simActivated).toBeNull()
  })

  it('carries the D100 freshness watermark', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progA, batchId: BATCH, pipelineState: 'BATCHED' })
    const view = (await readBatchJourney(db, { kind: 'crossTenant' }, BATCH))!
    expect(view.watermark.asOf).toBe('2026-08-11T09:00:00.000Z')
  })

  it('an own-scope caller never sees a batch belonging to another program (RLS backstop)', async () => {
    await insertRow({ dispatchId: `asgn_${randomUUID()}`, programId: progB, batchId: BATCH, pipelineState: 'DELIVERED' })
    // progA's scope cannot see progB's rows, so the batch reads as absent.
    const view = await readBatchJourney(db, { kind: 'own', programIds: [progA] }, BATCH)
    expect(view).toBeNull()
    // Its real owner does see it.
    const owned = await readBatchJourney(db, { kind: 'own', programIds: [progB] }, BATCH)
    expect(owned?.counts.total).toBe(1)
  })
})
