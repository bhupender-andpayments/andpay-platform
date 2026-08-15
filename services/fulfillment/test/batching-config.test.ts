import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { onDemandAccrued } from '../src/batching.js'
import { resolvePoolConfig, resolveBankLotOverride, DEFAULT_POOL_CFG } from '../src/config/pool-config.js'
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

async function seedPooled(
  tenantUuid: string,
  programUuid: string,
  traceId: string,
  createdAt: Date,
  // R-7: the entry's bank, so the per-bank tests can pool two banks side by
  // side. The default keeps every pre-R-7 call site byte-identical.
  bankReferenceCode = 'HDFC',
): Promise<void> {
  const asgnUuid = toUuid(newId('asgn'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, true, 1, 1, true,
      'Acme', 'Acme Pvt Ltd', '5814', ${bankReferenceCode}, 'HDFC Bank', '221B Baker Street',
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

// R-7 (16 Aug 2026, docs/plan/UAT_DECISIONS_2026-08-16.md): the per-bank MIN
// LOT override tier, revising D-10. A bank WITH a row batches its own entries
// by its own threshold; a bank WITHOUT one participates in the pool-wide count
// exactly as before the tier existed; max wait never lives on a bank row.
describe('per-bank batching overrides (R-7)', () => {
  async function seedBankLot(tenantWire: string, programWire: string, bank: string, minLotSize: number): Promise<void> {
    await db.$executeRaw`
      INSERT INTO batching_config (id, tenant_wire, program_wire, bank_reference_code, min_lot_size, max_wait_seconds, updated_at)
      VALUES (gen_random_uuid(), ${tenantWire}, ${programWire}, ${bank}, ${minLotSize}, NULL, now())
    `
  }

  it('a bank-tier row never leaks into the POOL ladder (resolvePoolConfig is bank-blind)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    await seedBankLot(tenantWire, programWire, '019', 2)
    const cfg = await resolvePoolConfig(db, tenantWire, programWire)
    expect(cfg).toEqual(DEFAULT_POOL_CFG)
  })

  it('resolveBankLotOverride: no row is null, (tenant, program, bank) beats (tenant, "", bank), an empty bank is null', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    expect(await resolveBankLotOverride(db, tenantWire, programWire, '019')).toBeNull()
    await seedBankLot(tenantWire, '', '019', 30)
    expect(await resolveBankLotOverride(db, tenantWire, programWire, '019')).toBe(30)
    await seedBankLot(tenantWire, programWire, '019', 20)
    expect(await resolveBankLotOverride(db, tenantWire, programWire, '019')).toBe(20)
    expect(await resolveBankLotOverride(db, tenantWire, programWire, '')).toBeNull()
    expect(await resolveBankLotOverride(db, '', programWire, '019')).toBeNull()
  })

  it('the DB refuses a bank row carrying a wait ceiling, and a pool row missing one', async () => {
    const tenantWire = newId('tnnt')
    await expect(
      db.$executeRaw`
        INSERT INTO batching_config (id, tenant_wire, program_wire, bank_reference_code, min_lot_size, max_wait_seconds, updated_at)
        VALUES (gen_random_uuid(), ${tenantWire}, '', '019', 5, 60, now())
      `,
    ).rejects.toThrowError(/batching_config_bank_tier_wait/)
    await expect(
      db.$executeRaw`
        INSERT INTO batching_config (id, tenant_wire, program_wire, bank_reference_code, min_lot_size, max_wait_seconds, updated_at)
        VALUES (gen_random_uuid(), ${tenantWire}, '', '', 5, NULL, now())
      `,
    ).rejects.toThrowError(/batching_config_bank_tier_wait/)
    await expect(
      db.$executeRaw`
        INSERT INTO batching_config (id, tenant_wire, program_wire, bank_reference_code, min_lot_size, max_wait_seconds, updated_at)
        VALUES (gen_random_uuid(), '', '', '019', 5, NULL, now())
      `,
    ).rejects.toThrowError(/batching_config_bank_tier_scope/)
  })

  it('a bank at its override triggers a batch of ITS OWN entries only; the other bank stays POOLED', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await seedBankLot(tenantWire, programWire, '019', 2)

    await seedPooled(tenantUuid, programUuid, 'trace-a1', new Date(BASE.getTime() + 1000), '019')
    await seedPooled(tenantUuid, programUuid, 'trace-b1', new Date(BASE.getTime() + 2000), '042')
    await seedPooled(tenantUuid, programUuid, 'trace-a2', new Date(BASE.getTime() + 3000), '019')

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-bank-1', 'trace-a2', '019')
    expect(res.triggered).toBe(true) // 2 >= the bank override; the pool DEFAULT (50) would say no

    const batches = await db.$queryRaw<{ id: string; unit_count: number }[]>`SELECT id::text AS id, unit_count FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(2)

    const banks = await db.$queryRaw<{ bank_reference_code: string; pool_status: string }[]>`
      SELECT bank_reference_code, pool_status FROM pending_pool_entry ORDER BY created_at
    `
    expect(banks.filter((b) => b.bank_reference_code === '019').every((b) => b.pool_status === 'BATCHED')).toBe(true)
    expect(banks.filter((b) => b.bank_reference_code === '042').every((b) => b.pool_status === 'POOLED')).toBe(true)
  })

  it('a bank BELOW its override does not trigger, even when the pool total would clear a lower pool tier', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    // Pool tier would batch at 2; the bank's own override demands 5.
    await seedConfig(tenantWire, programWire, 2, 3600)
    await seedBankLot(tenantWire, programWire, '019', 5)

    await seedPooled(tenantUuid, programUuid, 'trace-a1', new Date(BASE.getTime() + 1000), '019')
    await seedPooled(tenantUuid, programUuid, 'trace-b1', new Date(BASE.getTime() + 2000), '042')

    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-bank-2', 'trace-a1', '019')
    expect(res.triggered).toBe(false)
    const n = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(n[0]!.n)).toBe(0)
  })

  it('a bank WITHOUT an override still batches pool-wide (pre-R-7 behavior, byte for byte)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    await seedConfig(tenantWire, programWire, 2, 3600)
    await seedBankLot(tenantWire, programWire, '019', 50)

    await seedPooled(tenantUuid, programUuid, 'trace-a1', new Date(BASE.getTime() + 1000), '019')
    await seedPooled(tenantUuid, programUuid, 'trace-b1', new Date(BASE.getTime() + 2000), '042')

    // Bank 042 has no override: the pool-wide count (2) clears the pool tier
    // (2), and the batch claims EVERYTHING pooled, the 019 entry included.
    const res = await onDemandAccrued(db, tenantWire, programWire, 'dedup-bank-3', 'trace-b1', '042')
    expect(res.triggered).toBe(true)
    const batches = await db.$queryRaw<{ unit_count: number }[]>`SELECT unit_count FROM batch`
    expect(batches).toHaveLength(1)
    expect(batches[0]!.unit_count).toBe(2)
  })

  it('upsertBatchingConfig writes a bank row (NULL wait), audits min lot only, and refuses the two invalid shapes', async () => {
    const tenantWire = newId('tnnt')
    const base = { clientKey: randomUUID(), actorId: randomUUID(), traceId: 't-cfg-bank' }
    const res = await upsertBatchingConfig(db, {
      tenantWire,
      bankReferenceCode: '019',
      minLotSize: 25,
      ...base,
    })
    expect(res.deduped).toBe(false)

    const rows = await db.$queryRaw<{ bank_reference_code: string; min_lot_size: number; max_wait_seconds: number | null }[]>`
      SELECT bank_reference_code, min_lot_size, max_wait_seconds FROM batching_config WHERE tenant_wire = ${tenantWire}
    `
    expect(rows).toEqual([{ bank_reference_code: '019', min_lot_size: 25, max_wait_seconds: null }])

    const audits = await auditRowsFor('ops:batching-config-set')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.resourceIds).toContain('scope:tenant-bank')
    expect(audits[0]!.resourceIds).toContain('bank:019')
    expect(audits[0]!.resourceIds.some((r) => r.startsWith('min-lot-size:old=50:new=25'))).toBe(true)
    expect(audits[0]!.resourceIds.some((r) => r.startsWith('max-wait-seconds:'))).toBe(false)

    // A bank scope without a tenant, and a bank scope carrying a wait ceiling:
    // both 4xx before any transaction opens.
    await expect(
      upsertBatchingConfig(db, { bankReferenceCode: '019', minLotSize: 5, clientKey: randomUUID(), actorId: base.actorId, traceId: base.traceId }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    await expect(
      upsertBatchingConfig(db, { tenantWire, bankReferenceCode: '019', minLotSize: 5, maxWaitSeconds: 60, clientKey: randomUUID(), actorId: base.actorId, traceId: base.traceId }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    // A POOL-tier write still requires the wait ceiling now that the field is
    // optional on the shape.
    await expect(
      upsertBatchingConfig(db, { tenantWire, minLotSize: 5, clientKey: randomUUID(), actorId: base.actorId, traceId: base.traceId }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })
})
