import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readTiles, readTileDrilldown } from '../src/mediation.js'

// C-4 / design D8: "total batches to date".
//
// The other seven tiles count RECORDS. A batch is a different unit, and one
// batch holds many records, so counting rows would report the number of BATCHED
// RECORDS, which is exactly the mistake this tile exists to correct. Every
// assertion below is about that distinction.

const db = new PrismaClient({
  datasourceUrl:
    process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics',
})

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark CASCADE')
})

const P1 = toUuid(newId('prog'))
const P2 = toUuid(newId('prog'))

async function seed(opts: {
  dispatchId: string
  programId: string
  batchId: string | null
  bankCode?: string
}): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, batch_id, updated_at)
    VALUES (${opts.dispatchId}, ${opts.programId}::uuid, ${opts.bankCode ?? 'HDFC'}, 'HDFC Bank', 'Acme',
            ARRAY['DEV1']::text[], 'BATCHED', true, now(), ${opts.batchId}, now())`
}

const ALL = { kind: 'crossTenant' } as const

describe('totalBatches counts BATCHES, not batched records', () => {
  it('counts one batch once, however many records it holds', async () => {
    // THE WHOLE POINT. Three records, one batch: the answer is 1, not 3.
    await seed({ dispatchId: 'd1', programId: P1, batchId: 'btch_a' })
    await seed({ dispatchId: 'd2', programId: P1, batchId: 'btch_a' })
    await seed({ dispatchId: 'd3', programId: P1, batchId: 'btch_a' })

    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.totalBatches).toBe(1)
  })

  it('counts distinct batches', async () => {
    await seed({ dispatchId: 'd1', programId: P1, batchId: 'btch_a' })
    await seed({ dispatchId: 'd2', programId: P1, batchId: 'btch_b' })
    await seed({ dispatchId: 'd3', programId: P1, batchId: 'btch_b' })

    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.totalBatches).toBe(2)
  })

  it('does not count an unbatched record as a batch', async () => {
    // A record exists from the assignment fact onward, long before any batch
    // forms, so NULL is a real state and must not become one anonymous batch.
    await seed({ dispatchId: 'd1', programId: P1, batchId: null })
    await seed({ dispatchId: 'd2', programId: P1, batchId: null })

    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.totalBatches).toBe(0)
  })

  it('reads zero on an empty rail rather than failing', async () => {
    const { tiles } = await readTiles(db, ALL, {})
    expect(tiles.totalBatches).toBe(0)
  })
})

describe('totalBatches decomposes per Program (D97), like every other tile', () => {
  it('a program-scoped read counts only that program batches', async () => {
    // { kind: 'own', programIds } is the real scope shape. An earlier draft
    // wrote { kind: 'programs' }, which typechecks as invalid but happened to
    // work at runtime because anything that is not 'crossTenant' takes the
    // program_ids branch. It passed for the wrong reason until tsc said so.
    await seed({ dispatchId: 'd1', programId: P1, batchId: 'btch_a' })
    await seed({ dispatchId: 'd2', programId: P2, batchId: 'btch_b' })
    await seed({ dispatchId: 'd3', programId: P2, batchId: 'btch_c' })

    const all = await readTiles(db, ALL, {})
    expect(all.tiles.totalBatches).toBe(3)

    const scoped = await readTiles(db, { kind: 'own', programIds: [P2] }, {})
    expect(scoped.tiles.totalBatches).toBe(2)
  })
})

describe('totalBatches honours the same filters as its neighbours', () => {
  it('narrows by bank, so a filtered dashboard cannot contradict itself', async () => {
    // The reason the batch id is stored on the ROW rather than counted from
    // raw_event: a raw_event count could not answer a bank filter, so an
    // operator narrowing to one bank would have seen a batch number that
    // disagreed with every tile beside it.
    await seed({ dispatchId: 'd1', programId: P1, batchId: 'btch_a', bankCode: 'HDFC' })
    await seed({ dispatchId: 'd2', programId: P1, batchId: 'btch_b', bankCode: 'ICICI' })

    const unfiltered = await readTiles(db, ALL, {})
    expect(unfiltered.tiles.totalBatches).toBe(2)

    const filtered = await readTiles(db, ALL, { bankCode: 'ICICI' })
    expect(filtered.tiles.totalBatches).toBe(1)
  })
})

describe('the totalBatches drilldown', () => {
  it('lists the RECORDS in batches, which is what a record-shaped report can answer', async () => {
    // The tile counts distinct batches while the drilldown lists records. That
    // asymmetry is deliberate: every report row is a dispatch record, so there
    // is no batch-shaped row to list.
    await seed({ dispatchId: 'd1', programId: P1, batchId: 'btch_a' })
    await seed({ dispatchId: 'd2', programId: P1, batchId: 'btch_a' })
    await seed({ dispatchId: 'd3', programId: P1, batchId: null })

    const { rows } = await readTileDrilldown(db, ALL, 'totalBatches', {})
    expect(rows).toHaveLength(2)
  })
})
