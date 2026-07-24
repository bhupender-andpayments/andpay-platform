import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { manualTrigger, holdEntry, onDemandAccrued } from '../src/batching.js'
import { poolConfig } from '../src/config/pool-config.js'

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

// A fixture pending_pool_entry row, inserted directly (mirrors
// test/batching-lotsize.test.ts's own seedPooled): updated_at and trace_id
// are NOT NULL columns, both set explicitly so the fixture never depends on a
// column default.
async function seedPooled(
  tenantUuid: string,
  programUuid: string,
  traceId: string,
  createdAt: Date,
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
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', 'file-1|1', ${traceId}, ${createdAt}, now()
    )
  `
  return { asgnWire, asgnUuid }
}

describe('manualTrigger (class-3 MANUAL batch trigger, check 3c)', () => {
  it('3 POOLED entries below minLotSize: creates ONE BORN/MANUAL batch, records triggered_by_actor, re-arms the max_wait timer; a re-invocation with the SAME opsToken does not create a second batch', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize } = poolConfig(tenantWire, programWire)
    expect(minLotSize).toBeGreaterThan(3) // below-minLotSize is the point of this test

    const seeded: { asgnWire: string; traceId: string }[] = []
    for (let i = 0; i < 3; i++) {
      const traceId = `trace-${String(i)}`
      const { asgnWire } = await seedPooled(tenantUuid, programUuid, traceId, new Date(BASE.getTime() + i * 1000))
      seeded.push({ asgnWire, traceId })
    }

    const actor = { operatorId: randomUUID() }
    const opsToken = 'ops-token-1'

    const res1 = await manualTrigger(db, tenantWire, programWire, actor, opsToken, 'trace-manual-1')
    expect(res1).not.toBeNull()
    const btchId = res1!.btchId

    const batches = await db.$queryRaw<
      { id: string; status: string; trigger_reason: string; unit_count: number; triggered_by_actor: string }[]
    >`SELECT id::text AS id, status, trigger_reason, unit_count, triggered_by_actor::text AS triggered_by_actor FROM batch
       WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.status).toBe('BORN')
    expect(batches[0]!.trigger_reason).toBe('MANUAL')
    expect(batches[0]!.unit_count).toBe(3)
    expect(batches[0]!.triggered_by_actor).toBe(actor.operatorId)
    expect(fromUuid('btch', batches[0]!.id)).toBe(btchId)

    // below minLotSize would never have triggered on its own: proves the
    // class-3 MANUAL path bypasses the minLotSize gate entirely.
    const noAccrual = await onDemandAccrued(db, tenantWire, programWire, 'dedup-post-manual', 'trace-post-manual')
    expect(noAccrual.triggered).toBe(false) // nothing left POOLED to accrue

    // re-arm: exactly one pending max_wait timer for the pool (the pre-manual
    // one, armed by ensurePool, is superseded).
    const pool = await db.$queryRaw<{ pm_instance_id: string }[]>`
      SELECT pm_instance_id::text AS pm_instance_id FROM batch_pool
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    expect(pool).toHaveLength(1)
    const timers = await db.$queryRaw<{ status: string; purpose: string }[]>`
      SELECT status, purpose FROM saga_timer WHERE instance_id = ${pool[0]!.pm_instance_id}::uuid
    `
    const pending = timers.filter((t) => t.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.purpose).toBe('max_wait')

    // a re-invocation with the SAME opsToken (MANUAL epoch idempotency) must
    // NOT create a second batch, even though a fresh POOLED entry now exists.
    const fresh = await seedPooled(tenantUuid, programUuid, 'trace-fresh', new Date(BASE.getTime() + 10_000))
    const res2 = await manualTrigger(db, tenantWire, programWire, actor, opsToken, 'trace-manual-2')
    expect(res2).toBeNull()

    const batchCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount[0]!.n)).toBe(1)

    const freshRow = await db.$queryRaw<{ pool_status: string }[]>`
      SELECT pool_status FROM pending_pool_entry WHERE asgn_id = ${fresh.asgnUuid}::uuid
    `
    expect(freshRow[0]!.pool_status).toBe('POOLED') // untouched by the deduped re-invocation
  })

  it('returns null and creates no batch when nothing is POOLED', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const actor = { operatorId: randomUUID() }

    const res = await manualTrigger(db, tenantWire, programWire, actor, 'ops-token-empty', 'trace-empty')
    expect(res).toBeNull()

    const batchCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount[0]!.n)).toBe(0)
  })
})

describe('holdEntry (record-HOLD, check 3d)', () => {
  it('moves a POOLED entry to HELD, records held_by_actor + held_at, advances updated_at, and a subsequent trigger excludes it', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize } = poolConfig(tenantWire, programWire)

    const held = await seedPooled(tenantUuid, programUuid, 'trace-to-hold', BASE)

    const preHold = new Date()
    // A small real delay so the assertion below (updated_at strictly PAST
    // preHold) cannot land in the same millisecond as this mark: Date.getTime()
    // truncates to milliseconds while Postgres timestamptz has microsecond
    // resolution, so back-to-back real now() calls with no gap can otherwise
    // read as equal at millisecond granularity.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const actor = { operatorId: randomUUID() }
    await holdEntry(db, held.asgnWire, actor)

    const heldRow = await db.$queryRaw<
      { pool_status: string; held_by_actor: string | null; held_at: Date | null; updated_at: Date }[]
    >`SELECT pool_status, held_by_actor::text AS held_by_actor, held_at, updated_at
       FROM pending_pool_entry WHERE asgn_id = ${held.asgnUuid}::uuid`
    expect(heldRow).toHaveLength(1)
    expect(heldRow[0]!.pool_status).toBe('HELD')
    expect(heldRow[0]!.held_by_actor).toBe(actor.operatorId)
    expect(heldRow[0]!.held_at).not.toBeNull()
    expect(heldRow[0]!.updated_at.getTime()).toBeGreaterThan(preHold.getTime())

    // seed enough OTHER POOLED entries to actually trigger a LOT_SIZE batch.
    const others: { asgnWire: string; asgnUuid: string }[] = []
    for (let i = 0; i < minLotSize; i++) {
      others.push(await seedPooled(tenantUuid, programUuid, `trace-other-${String(i)}`, new Date(BASE.getTime() + (i + 1) * 1000)))
    }

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-hold-exclusion', 'trace-hold-exclusion')
    expect(res.triggered).toBe(true)

    const batches = await db.$queryRaw<{ unit_count: number }[]>`
      SELECT unit_count FROM batch WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(minLotSize) // the HELD entry is NOT counted

    // the HELD entry stays HELD: not marked BATCHED, not swept into the batch.
    const afterTrigger = await db.$queryRaw<{ pool_status: string; batch: string | null; held_by_actor: string | null }[]>`
      SELECT pool_status, batch::text AS batch, held_by_actor::text AS held_by_actor
      FROM pending_pool_entry WHERE asgn_id = ${held.asgnUuid}::uuid
    `
    expect(afterTrigger[0]!.pool_status).toBe('HELD')
    expect(afterTrigger[0]!.batch).toBeNull()
    expect(afterTrigger[0]!.held_by_actor).toBe(actor.operatorId)

    // every OTHER entry got BATCHED (the HELD one excluded from the set).
    const allEntries = await db.$queryRaw<{ asgn_id: string; pool_status: string }[]>`
      SELECT asgn_id::text AS asgn_id, pool_status FROM pending_pool_entry
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    for (const o of others) {
      const row = allEntries.find((r) => r.asgn_id === o.asgnUuid)
      expect(row?.pool_status).toBe('BATCHED')
    }
  })

  it('a BATCHED entry is untouched (the AND pool_status=POOLED guard)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const { minLotSize } = poolConfig(tenantWire, programWire)

    const seeded: { asgnWire: string; asgnUuid: string }[] = []
    for (let i = 0; i < minLotSize; i++) {
      seeded.push(await seedPooled(tenantUuid, programUuid, `trace-${String(i)}`, new Date(BASE.getTime() + i * 1000)))
    }
    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-pre-batch', 'trace-pre-batch')
    expect(res.triggered).toBe(true)

    const target = seeded[0]!
    const before = await db.$queryRaw<{ pool_status: string; batch: string | null }[]>`
      SELECT pool_status, batch::text AS batch FROM pending_pool_entry WHERE asgn_id = ${target.asgnUuid}::uuid
    `
    expect(before[0]!.pool_status).toBe('BATCHED')
    const priorBatch = before[0]!.batch

    const actor = { operatorId: randomUUID() }
    await holdEntry(db, target.asgnWire, actor)

    const after = await db.$queryRaw<
      { pool_status: string; batch: string | null; held_by_actor: string | null }[]
    >`SELECT pool_status, batch::text AS batch, held_by_actor::text AS held_by_actor
       FROM pending_pool_entry WHERE asgn_id = ${target.asgnUuid}::uuid`
    expect(after[0]!.pool_status).toBe('BATCHED') // untouched: guard excludes non-POOLED rows
    expect(after[0]!.batch).toBe(priorBatch)
    expect(after[0]!.held_by_actor).toBeNull()
  })

  it('a nonexistent asgnId is a safe no-op', async () => {
    const asgnWire = newId('asgn')
    const actor = { operatorId: randomUUID() }
    await expect(holdEntry(db, asgnWire, actor)).resolves.toBeUndefined()
  })
})
