import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { ensurePool, triggerBatch, onDemandAccrued } from '../src/batching.js'
import { poolConfig } from '../src/config/pool-config.js'
import { BATCH_TOPIC, type BatchFactPayload } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

const BASE = new Date('2026-01-01T00:00:00.000Z')

// A fixture pending_pool_entry row, inserted directly (not via
// projectDemandFact) so the test controls created_at (for a deterministic
// "oldest" entry) and trace_id independently. updated_at and trace_id are
// NOT NULL columns; the fixture sets both explicitly. pool_status defaults to
// POOLED; pass 'HELD' to seed a row the lot-size gate must exclude.
async function seedPooled(
  tenantUuid: string,
  programUuid: string,
  traceId: string,
  createdAt: Date,
  poolStatus: 'POOLED' | 'HELD' = 'POOLED',
): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, true, 1, 1, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', ${poolStatus}, 'file-1|1', ${traceId}, ${createdAt}, now()
    )
  `
  return { asgnWire, asgnUuid }
}

interface BatchOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<BatchFactPayload>
}

describe('onDemandAccrued / triggerBatch (batching pool anchor and lot-size trigger on the D77 engine, check 3a)', () => {
  it('below minLotSize: no trigger, no batch row (ensurePool still creates the pool anchor + its first max_wait timer)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize } = poolConfig(tenantWire, programWire)

    for (let i = 0; i < minLotSize - 1; i++) {
      await seedPooled(tenantUuid, programUuid, `trace-${i}`, new Date(BASE.getTime() + i * 1000))
    }

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-below', 'trace-triggering')
    expect(res.triggered).toBe(false)
    expect(res.btchId).toBeUndefined()

    const batchCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount[0]!.n)).toBe(0)

    // ensurePool ran as a side effect: the anchor and its FIRST max_wait timer exist.
    const pool = await db.$queryRaw<{ id: string; pm_instance_id: string }[]>`
      SELECT id::text AS id, pm_instance_id::text AS pm_instance_id FROM batch_pool
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    expect(pool).toHaveLength(1)
    const timers = await db.$queryRaw<{ status: string; purpose: string }[]>`
      SELECT status, purpose FROM saga_timer WHERE instance_id = ${pool[0]!.pm_instance_id}::uuid
    `
    expect(timers).toHaveLength(1)
    expect(timers[0]!.status).toBe('pending')
    expect(timers[0]!.purpose).toBe('max_wait')
  })

  it('at minLotSize: exactly one BORN/LOT_SIZE batch, entries flip to BATCHED, one batch fact with the oldest trace_id and the asgn_id set; timers supersede-and-re-arm (C2); a second call with no new POOLED entries creates no second batch', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize, maxWaitSeconds } = poolConfig(tenantWire, programWire)

    const seeded: { asgnWire: string; asgnUuid: string; traceId: string }[] = []
    for (let i = 0; i < minLotSize; i++) {
      const traceId = `trace-${i}`
      const { asgnWire, asgnUuid } = await seedPooled(
        tenantUuid,
        programUuid,
        traceId,
        new Date(BASE.getTime() + i * 1000),
      )
      seeded.push({ asgnWire, asgnUuid, traceId })
    }
    const oldest = seeded[0]! // i = 0 has the earliest created_at: the expected batch-fact trace

    // Captured AFTER seeding completes and BEFORE the trigger runs. seedPooled
    // sets each fixture row's updated_at to a REAL now() at insert time, which
    // already exceeds any BASE-derived fake threshold; only a real wall-clock
    // mark captured right before the trigger proves the mark-BATCHED UPDATE's
    // updated_at = now() actually advances the column past this point.
    const preTrigger = new Date()

    // capture the pool's FIRST timer (armed by ensurePool on first touch) before triggering
    const anchor = await ensurePool(db, tenantWire, programWire)
    const preTimers = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM saga_timer WHERE instance_id = ${anchor.pmInstanceId}::uuid AND status = 'pending'
    `
    expect(preTimers).toHaveLength(1)
    const firstTimerId = preTimers[0]!.id

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-at-threshold', 'trace-triggering')
    expect(res.triggered).toBe(true)
    expect(res.btchId).toBeDefined()
    const btchId = res.btchId!

    // exactly one batch, BORN/LOT_SIZE, unit_count = minLotSize
    const batches = await db.$queryRaw<
      {
        id: string
        status: string
        trigger_reason: string
        unit_count: number
        tenant_id: string
        program_id: string
      }[]
    >`SELECT id::text AS id, status, trigger_reason, unit_count, tenant_id::text AS tenant_id, program_id::text AS program_id FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.status).toBe('BORN')
    expect(batches[0]!.trigger_reason).toBe('LOT_SIZE')
    expect(batches[0]!.unit_count).toBe(minLotSize)
    expect(batches[0]!.tenant_id).toBe(tenantUuid)
    expect(batches[0]!.program_id).toBe(programUuid)
    expect(fromUuid('btch', batches[0]!.id)).toBe(btchId)

    // every seeded entry flipped to BATCHED with the batch ref, updated_at advanced
    const entries = await db.$queryRaw<
      { asgn_id: string; pool_status: string; batch: string | null; updated_at: Date }[]
    >`SELECT asgn_id::text AS asgn_id, pool_status, batch::text AS batch, updated_at FROM pending_pool_entry
       WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid`
    expect(entries).toHaveLength(minLotSize)
    for (const row of entries) {
      expect(row.pool_status).toBe('BATCHED')
      expect(row.batch).toBe(toUuid(btchId))
      expect(row.updated_at.getTime()).toBeGreaterThan(preTrigger.getTime())
    }

    // exactly one fct.fulfillment.batch.v1 fact, carrying the asgn_id set and the oldest trace_id
    const ob = await db.$queryRaw<BatchOutboxRow[]>`SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${BATCH_TOPIC}`
    expect(ob).toHaveLength(1)
    const fact = ob[0]!
    expect(fact.partition_key).toBe(btchId)
    expect(fact.payload.traceId).toBe(oldest.traceId)
    expect(fact.payload.payload.btchId).toBe(btchId)
    expect(fact.payload.payload.tenantId).toBe(tenantWire)
    expect(fact.payload.payload.programId).toBe(programWire)
    expect(fact.payload.payload.triggerReason).toBe('LOT_SIZE')
    expect(fact.payload.payload.unitCount).toBe(minLotSize)
    expect(new Set(fact.payload.payload.asgnIds)).toEqual(new Set(seeded.map((s) => s.asgnWire)))

    // RE-ARM (C2): exactly one pending max_wait timer for the pool with a
    // fresh fire_at ~= now() + maxWaitSeconds; the original pool-creation
    // timer is superseded.
    const timers = await db.$queryRaw<{ id: string; status: string; purpose: string; fire_at: Date }[]>`
      SELECT id::text AS id, status, purpose, fire_at FROM saga_timer WHERE instance_id = ${anchor.pmInstanceId}::uuid
    `
    expect(timers).toHaveLength(2)
    const pending = timers.filter((t) => t.status === 'pending')
    const superseded = timers.filter((t) => t.status === 'superseded')
    expect(pending).toHaveLength(1)
    expect(superseded).toHaveLength(1)
    expect(superseded[0]!.id).toBe(firstTimerId)
    expect(pending[0]!.purpose).toBe('max_wait')
    const expectedFireAt = Date.now() + maxWaitSeconds * 1000
    expect(Math.abs(pending[0]!.fire_at.getTime() - expectedFireAt)).toBeLessThan(5000)

    // a second onDemandAccrued with no new POOLED entries does not create a second batch
    const again = await onDemandAccrued(db, tenantWire, programWire, 'dedup-again', 'trace-again')
    expect(again.triggered).toBe(false)
    const batchCount2 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount2[0]!.n)).toBe(1)
  })

  it('triggerBatch returns null and leaves the pool timer untouched when nothing is POOLED (C4 RETURNING gate)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')

    const { pmInstanceId } = await ensurePool(db, tenantWire, programWire)
    const before = await db.$queryRaw<{ status: string }[]>`SELECT status FROM saga_timer WHERE instance_id = ${pmInstanceId}::uuid`
    expect(before).toHaveLength(1)
    expect(before[0]!.status).toBe('pending')

    const res = await triggerBatch(db, tenantWire, programWire, 'LOT_SIZE', { epoch: 'epoch-empty-pool' })
    expect(res).toBeNull()

    const batchCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount[0]!.n)).toBe(0)

    // the early return (claimed.length === 0) happens BEFORE the supersede/
    // re-arm block, so the pool's original timer must be untouched.
    const after = await db.$queryRaw<{ status: string }[]>`SELECT status FROM saga_timer WHERE instance_id = ${pmInstanceId}::uuid`
    expect(after).toHaveLength(1)
    expect(after[0]!.status).toBe('pending')
  })

  it('epoch idempotency is isolated from the POOLED-count gate: a redelivery with the SAME epoch is a no-op even when a fresh POOLED entry now exists', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await ensurePool(db, tenantWire, programWire)

    const first = await seedPooled(tenantUuid, programUuid, 'trace-first', BASE)
    const epoch = 'manual-epoch-1'
    const res1 = await triggerBatch(db, tenantWire, programWire, 'MANUAL', { epoch })
    expect(res1).not.toBeNull()
    expect(res1!.unitCount).toBe(1)

    const firstRow = await db.$queryRaw<{ pool_status: string; batch: string | null }[]>`
      SELECT pool_status, batch::text AS batch FROM pending_pool_entry WHERE asgn_id = ${first.asgnUuid}::uuid
    `
    expect(firstRow[0]!.pool_status).toBe('BATCHED')
    expect(firstRow[0]!.batch).toBe(toUuid(res1!.btchId))

    // a fresh POOLED entry now exists, but the SAME epoch must still dedupe
    const second = await seedPooled(tenantUuid, programUuid, 'trace-second', new Date(BASE.getTime() + 1000))
    const res2 = await triggerBatch(db, tenantWire, programWire, 'MANUAL', { epoch })
    expect(res2).toBeNull()

    const batchCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount[0]!.n)).toBe(1)

    // the second entry was never touched: still POOLED, un-batched
    const secondRow = await db.$queryRaw<{ pool_status: string }[]>`
      SELECT pool_status FROM pending_pool_entry WHERE asgn_id = ${second.asgnUuid}::uuid
    `
    expect(secondRow[0]!.pool_status).toBe('POOLED')
  })

  it('ensurePool is race-safe: concurrent creations resolve to the SAME pool anchor with no orphan saga_instance or duplicate timer', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')

    const [a, b] = await Promise.all([
      ensurePool(db, tenantWire, programWire),
      ensurePool(db, tenantWire, programWire),
    ])
    expect(a.poolId).toBe(b.poolId)
    expect(a.pmInstanceId).toBe(b.pmInstanceId)

    const pools = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM batch_pool
      WHERE tenant_id = ${toUuid(tenantWire)}::uuid AND program_id = ${toUuid(programWire)}::uuid
    `
    expect(Number(pools[0]!.n)).toBe(1)

    const instances = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM saga_instance WHERE id = ${a.pmInstanceId}::uuid`
    expect(Number(instances[0]!.n)).toBe(1) // no orphan saga_instance from the losing racer

    const timers = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM saga_timer WHERE instance_id = ${a.pmInstanceId}::uuid`
    expect(Number(timers[0]!.n)).toBe(1) // exactly one max_wait timer, not two
  })

  it('HELD entries are excluded from the lot-size gate and from the batch when it fires', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize } = poolConfig(tenantWire, programWire)

    // minLotSize - 1 POOLED rows plus 1 HELD row: HELD must not count toward the gate.
    for (let i = 0; i < minLotSize - 1; i++) {
      await seedPooled(tenantUuid, programUuid, `trace-${i}`, new Date(BASE.getTime() + i * 1000))
    }
    const held = await seedPooled(
      tenantUuid,
      programUuid,
      'trace-held',
      new Date(BASE.getTime() + (minLotSize - 1) * 1000),
      'HELD',
    )

    const res1 = await onDemandAccrued(db, tenantWire, programWire, 'dedup-held-1', 'trace-triggering-1')
    expect(res1.triggered).toBe(false)
    const batchCount1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount1[0]!.n)).toBe(0)

    // one more POOLED row crosses the threshold; HELD still does not count
    const crossing = await seedPooled(
      tenantUuid,
      programUuid,
      'trace-crossing',
      new Date(BASE.getTime() + minLotSize * 1000),
    )

    const res2 = await onDemandAccrued(db, tenantWire, programWire, 'dedup-held-2', 'trace-triggering-2')
    expect(res2.triggered).toBe(true)
    expect(res2.btchId).toBeDefined()

    const batches = await db.$queryRaw<{ unit_count: number }[]>`SELECT unit_count FROM batch`
    expect(batches).toHaveLength(1)
    // (minLotSize - 1) POOLED + the crossing row = minLotSize; the HELD row is excluded
    expect(batches[0]!.unit_count).toBe(minLotSize)

    const ob = await db.$queryRaw<BatchOutboxRow[]>`SELECT payload FROM outbox WHERE event_type = ${BATCH_TOPIC}`
    expect(ob).toHaveLength(1)
    expect(ob[0]!.payload.payload.unitCount).toBe(minLotSize)
    expect(ob[0]!.payload.payload.asgnIds).not.toContain(held.asgnWire)
    expect(ob[0]!.payload.payload.asgnIds).toContain(crossing.asgnWire)

    // the HELD row is untouched by the trigger
    const heldRow = await db.$queryRaw<{ pool_status: string; batch: string | null }[]>`
      SELECT pool_status, batch::text AS batch FROM pending_pool_entry WHERE asgn_id = ${held.asgnUuid}::uuid
    `
    expect(heldRow[0]!.pool_status).toBe('HELD')
    expect(heldRow[0]!.batch).toBeNull()
  })

  it('more than minLotSize POOLED rows: the single batch sweeps ALL of them, not capped at minLotSize', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize } = poolConfig(tenantWire, programWire)
    const total = minLotSize + 10

    for (let i = 0; i < total; i++) {
      await seedPooled(tenantUuid, programUuid, `trace-${i}`, new Date(BASE.getTime() + i * 1000))
    }

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-over-minlotsize', 'trace-triggering-over')
    expect(res.triggered).toBe(true)

    const batches = await db.$queryRaw<{ unit_count: number }[]>`SELECT unit_count FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(total) // all POOLED swept, not capped at minLotSize

    const entries = await db.$queryRaw<{ pool_status: string }[]>`
      SELECT pool_status FROM pending_pool_entry
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    expect(entries).toHaveLength(total)
    expect(entries.every((e) => e.pool_status === 'BATCHED')).toBe(true)
  })
})
