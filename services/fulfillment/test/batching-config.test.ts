import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { onDemandAccrued } from '../src/batching.js'
import { resolvePoolConfig, DEFAULT_POOL_CFG } from '../src/config/pool-config.js'
import { upsertBatchingConfig, OpsClientError } from '../src/ops.js'

// Phase 3 Task 6 (BRD 5.3.2): the DB-backed batching-parameter store, revising
// S23. Covers the resolver precedence (an EMPTY table reproduces the code
// DEFAULT), a small integration proof that a configured value actually drives
// the lot-size gate and the max-wait timer, and the admin upsert's old+new 6e
// and validation. Direct-function shape (mirrors batching-ops / ops-bank-config
// tests); the HTTP authz differentiation lives in apps/ops-edge/test.
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const TABLES =
  'pending_pool_entry, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox, batching_config'

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
})
afterAll(async () => {
  // Leave batching_config EMPTY for whichever file runs next: a leaked scope
  // row would silently change resolvePoolConfig's answer for the other batching
  // suites (they assume the code DEFAULT).
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
  await db.$disconnect()
})

const BASE = new Date('2026-01-01T00:00:00.000Z')

async function seedConfig(
  tenantWire: string,
  programWire: string,
  minLotSize: number,
  maxWaitSeconds: number,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO batching_config (id, tenant_wire, program_wire, min_lot_size, max_wait_seconds, updated_at)
    VALUES (gen_random_uuid(), ${tenantWire}, ${programWire}, ${minLotSize}, ${maxWaitSeconds}, now())
  `
}

async function seedPooled(tenantUuid: string, programUuid: string, traceId: string, createdAt: Date): Promise<void> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, true, 1, 1, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', ${'file-' + traceId}, ${traceId}, ${createdAt}, now()
    )
  `
}

async function auditRowsFor(operation: string): Promise<{ decision: string; resourceIds: string[] }[]> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[] } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [] }))
}

describe('resolvePoolConfig precedence (Phase 3 Task 6)', () => {
  it('an EMPTY batching_config yields the code DEFAULT (50 / 7 days) for every pool', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const cfg = await resolvePoolConfig(db, tenantWire, programWire)
    expect(cfg).toEqual(DEFAULT_POOL_CFG)
    expect(cfg.minLotSize).toBe(50)
    expect(cfg.maxWaitSeconds).toBe(7 * 24 * 3600)
  })

  it('GLOBAL row applies when no tenant/program row exists', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    await seedConfig('', '', 11, 111)
    const cfg = await resolvePoolConfig(db, tenantWire, programWire)
    expect(cfg).toEqual({ minLotSize: 11, maxWaitSeconds: 111 })
  })

  it('the per-tenant row beats GLOBAL', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    await seedConfig('', '', 11, 111)
    await seedConfig(tenantWire, '', 22, 222)
    const cfg = await resolvePoolConfig(db, tenantWire, programWire)
    expect(cfg).toEqual({ minLotSize: 22, maxWaitSeconds: 222 })
  })

  it('the per-(tenant, program) row beats the per-tenant and GLOBAL rows', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    await seedConfig('', '', 11, 111)
    await seedConfig(tenantWire, '', 22, 222)
    await seedConfig(tenantWire, programWire, 33, 333)
    const cfg = await resolvePoolConfig(db, tenantWire, programWire)
    expect(cfg).toEqual({ minLotSize: 33, maxWaitSeconds: 333 })
  })

  it("a different tenant's row does NOT leak: the queried pool falls back to DEFAULT", async () => {
    const tenantWire = newId('tnnt')
    const otherTenant = newId('tnnt')
    const programWire = newId('prog')
    await seedConfig(otherTenant, '', 22, 222)
    const cfg = await resolvePoolConfig(db, tenantWire, programWire)
    expect(cfg).toEqual(DEFAULT_POOL_CFG)
  })
})

describe('resolvePoolConfig drives the real batching effects (Phase 3 Task 6 integration proof)', () => {
  it('a configured GLOBAL minLotSize/maxWaitSeconds changes the lot-size gate AND the re-armed max-wait timer', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)

    // A GLOBAL override far below the code DEFAULT (50) and far shorter than the
    // 7-day DEFAULT window, so a trigger at 3 entries and a ~60s timer both
    // prove the DB value (not the code DEFAULT) reached the effects.
    await seedConfig('', '', 3, 60)

    for (let i = 0; i < 3; i++) {
      await seedPooled(tenantUuid, programUuid, `trace-${i}`, new Date(BASE.getTime() + i * 1000))
    }

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-cfg', 'trace-trigger')
    expect(res.triggered).toBe(true) // would be FALSE (3 < 50) on the code DEFAULT

    const batches = await db.$queryRaw<{ unit_count: number }[]>`SELECT unit_count FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(3)

    // The pool's single pending max_wait timer fires at ~now + 60s (the DB
    // value), nowhere near the 7-day code DEFAULT.
    const pool = await db.$queryRaw<{ pm_instance_id: string }[]>`
      SELECT pm_instance_id::text AS pm_instance_id FROM batch_pool
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    const timers = await db.$queryRaw<{ fire_at: Date }[]>`
      SELECT fire_at FROM saga_timer
      WHERE instance_id = ${pool[0]!.pm_instance_id}::uuid AND status = 'pending' AND purpose = 'max_wait'
    `
    expect(timers).toHaveLength(1)
    const secondsOut = (timers[0]!.fire_at.getTime() - Date.now()) / 1000
    expect(secondsOut).toBeGreaterThan(30)
    expect(secondsOut).toBeLessThan(3600) // NOT the 7-day (604800s) code DEFAULT
  })
})

describe('upsertBatchingConfig (Phase 3 Task 6, admin write, BRD 271 old+new audit)', () => {
  it('a first write on a scope audits the OLD value as the code DEFAULT and the NEW value written', async () => {
    const actorId = randomUUID()
    const res = await upsertBatchingConfig(db, {
      minLotSize: 10,
      maxWaitSeconds: 100,
      clientKey: randomUUID(),
      actorId,
      traceId: 't-cfg-1',
    })
    expect(res.deduped).toBe(false)
    expect(res.id).not.toBeNull()

    const rows = await auditRowsFor('ops:batching-config-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([
      res.id,
      'scope:global',
      `min-lot-size:old=${DEFAULT_POOL_CFG.minLotSize}:new=10`,
      `max-wait-seconds:old=${DEFAULT_POOL_CFG.maxWaitSeconds}:new=100`,
    ])

    // The resolver now returns the written GLOBAL value.
    const cfg = await resolvePoolConfig(db, newId('tnnt'), newId('prog'))
    expect(cfg).toEqual({ minLotSize: 10, maxWaitSeconds: 100 })
  })

  it('a second write on the SAME scope updates in place and audits the PRIOR value as old', async () => {
    const first = await upsertBatchingConfig(db, {
      minLotSize: 10,
      maxWaitSeconds: 100,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-cfg-2a',
    })
    const second = await upsertBatchingConfig(db, {
      minLotSize: 20,
      maxWaitSeconds: 200,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-cfg-2b',
    })
    expect(second.id).toBe(first.id) // same scope row (the upsert's natural key)

    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batching_config`
    expect(Number(n[0]!.n)).toBe(1)

    const rows = await auditRowsFor('ops:batching-config-set')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.resourceIds).toEqual([
      second.id,
      'scope:global',
      'min-lot-size:old=10:new=20',
      'max-wait-seconds:old=100:new=200',
    ])
  })

  it('a per-tenant and a per-(tenant,program) scope are DISTINCT rows with distinct scope tokens', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantScope = await upsertBatchingConfig(db, {
      tenantWire,
      minLotSize: 15,
      maxWaitSeconds: 150,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-cfg-3a',
    })
    const programScope = await upsertBatchingConfig(db, {
      tenantWire,
      programWire,
      minLotSize: 5,
      maxWaitSeconds: 50,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-cfg-3b',
    })
    expect(tenantScope.id).not.toBe(programScope.id)

    const rows = await auditRowsFor('ops:batching-config-set')
    expect(rows[0]!.resourceIds).toContain('scope:tenant')
    expect(rows[0]!.resourceIds).toContain(tenantWire)
    expect(rows[1]!.resourceIds).toContain('scope:tenant-program')
    expect(rows[1]!.resourceIds).toContain(programWire)
  })

  it('a replay (same clientKey) is deduped and emits no second 6e', async () => {
    const args = {
      minLotSize: 10,
      maxWaitSeconds: 100,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-cfg-4',
    }
    const first = await upsertBatchingConfig(db, args)
    expect(first.deduped).toBe(false)
    const replay = await upsertBatchingConfig(db, args)
    expect(replay.deduped).toBe(true)
    expect(replay.id).toBeNull()
    expect(await auditRowsFor('ops:batching-config-set')).toHaveLength(1)
  })

  it('validation: minLotSize < 1, maxWaitSeconds < 1, non-integers, and a program-only scope are all 4xx (no row, no 6e)', async () => {
    const base = { clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-cfg-5' }
    await expect(upsertBatchingConfig(db, { minLotSize: 0, maxWaitSeconds: 100, ...base })).rejects.toMatchObject({
      kind: 'invalid',
    })
    await expect(upsertBatchingConfig(db, { minLotSize: 10, maxWaitSeconds: 0, ...base })).rejects.toMatchObject({
      kind: 'invalid',
    })
    await expect(upsertBatchingConfig(db, { minLotSize: 1.5, maxWaitSeconds: 100, ...base })).rejects.toBeInstanceOf(
      OpsClientError,
    )
    await expect(
      upsertBatchingConfig(db, { programWire: newId('prog'), minLotSize: 10, maxWaitSeconds: 100, ...base }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    // No transaction opened for a rejected request: no row, no clientKey burned,
    // no 6e.
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batching_config`
    expect(Number(n[0]!.n)).toBe(0)
    expect(await auditRowsFor('ops:batching-config-set')).toHaveLength(0)
  })
})
