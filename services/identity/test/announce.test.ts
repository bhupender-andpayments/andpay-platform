import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '../generated/client/index.js'
import { createBankMaster, createAggregator, listBankMasters } from '../src/ops.js'
import { announceDefaultAggregators } from '../src/announce.js'

// The repair for the gap 20260820120000_backfill_default_aggregators left
// behind: a default aggregator inserted by SQL, with no fact, that TMS
// therefore never projected. See services/identity/src/announce.ts.
const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

function bankArgs(overrides: Record<string, unknown> = {}): Parameters<typeof createBankMaster>[1] {
  return {
    bankReferenceCode: 'BREF-ANN-1',
    displayName: 'Announce Bank',
    address1: '1 MG Road',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    country: 'India',
    pin: '560001',
    mobile: '9000000001',
    email: 'ops@announce.example',
    clientKey: randomUUID(),
    actorId: 'actor-ann',
    traceId: 'trace-ann',
    ...overrides,
  } as Parameters<typeof createBankMaster>[1]
}

async function aggregatorFacts(): Promise<
  { aggrId: string; tnntId: string; aggregatorCode: string; displayName: string; isDefault: boolean; status: string }[]
> {
  const rows = await db.$queryRaw<{ payload: { payload: Record<string, unknown> } }[]>`
    SELECT payload FROM outbox
    WHERE event_type = 'fct.identity.aggregator.v1'
    ORDER BY created_at ASC, id ASC
  `
  return rows.map((r) => r.payload.payload as never)
}

/**
 * The backfill migration's write, reproduced exactly: a default aggregator
 * inserted with plain SQL and no fact behind it.
 */
async function backfilledDefault(tenantUuid: string, code: string, name: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO aggregator (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
    VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${code}, ${name}, 'ACTIVE', true, now())
  `
}

async function tenantUuidOf(tnntId: string): Promise<string> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT t.id::text AS id FROM tenant t
    JOIN aggregator a ON a.tenant_id = t.id
    WHERE a.aggregator_code = ${tnntId}
  `
  return rows[0]!.id
}

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE aggregator, sub_merchant, merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox',
  )
})

describe('announceDefaultAggregators', () => {
  it('announces a default that was inserted without a fact, carrying its current values', async () => {
    // A tenant whose default arrived the way the backfill migration made them:
    // straight SQL, no envelope, nothing on the bus.
    const t = await createBankMaster(db, bankArgs())
    await db.$executeRawUnsafe('TRUNCATE outbox')
    const tenantUuid = await tenantUuidOf('BREF-ANN-1')
    await db.$executeRaw`DELETE FROM aggregator WHERE tenant_id = ${tenantUuid}::uuid`
    await backfilledDefault(tenantUuid, '3', 'GSCB')

    expect(await aggregatorFacts()).toHaveLength(0)

    const res = await announceDefaultAggregators(db, { traceId: 'trace-announce' })

    expect(res.announced).toHaveLength(1)
    expect(res.announced[0]!.aggregatorCode).toBe('3')
    expect(res.announced[0]!.tnntId).toBe(t.tnntId)
    expect(res.alreadyAnnounced).toBe(0)

    const facts = await aggregatorFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      aggrId: res.announced[0]!.aggrId,
      tnntId: t.tnntId,
      aggregatorCode: '3',
      displayName: 'GSCB',
      status: 'ACTIVE',
      isDefault: true,
    })
  })

  it('a second run announces nothing, because the step key is deterministic', async () => {
    await createBankMaster(db, bankArgs())
    await db.$executeRawUnsafe('TRUNCATE outbox')

    const first = await announceDefaultAggregators(db, { traceId: 'tr-1' })
    expect(first.announced).toHaveLength(1)

    const second = await announceDefaultAggregators(db, { traceId: 'tr-2' })
    expect(second.announced).toHaveLength(0)
    expect(second.alreadyAnnounced).toBe(1)

    // One fact on the bus, not two: the identity inbox gated the enqueue.
    expect(await aggregatorFacts()).toHaveLength(1)
  })

  it('announces only defaults, leaving the tenant\'s other aggregators alone', async () => {
    const t = await createBankMaster(db, bankArgs())
    await createAggregator(db, {
      tnntId: t.tnntId!, displayName: 'Second Bank', aggregatorCode: '18',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr',
    })
    await db.$executeRawUnsafe('TRUNCATE outbox')

    const res = await announceDefaultAggregators(db, { traceId: 'tr' })

    expect(res.announced.map((a) => a.aggregatorCode)).toEqual(['BREF-ANN-1'])
    const facts = await aggregatorFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0]!.isDefault).toBe(true)
  })

  it('announces one default per tenant, across every tenant', async () => {
    await createBankMaster(db, bankArgs())
    await createBankMaster(db, bankArgs({ bankReferenceCode: 'BREF-ANN-2', displayName: 'Second', clientKey: randomUUID() }))
    await db.$executeRawUnsafe('TRUNCATE outbox')

    const res = await announceDefaultAggregators(db, { traceId: 'tr' })

    expect(res.announced.map((a) => a.aggregatorCode).sort()).toEqual(['BREF-ANN-1', 'BREF-ANN-2'])
    expect(new Set(res.announced.map((a) => a.tnntId)).size).toBe(2)
    expect(await aggregatorFacts()).toHaveLength(2)
  })

  it('the announced values track identity, so a renamed default announces its new code', async () => {
    await createBankMaster(db, bankArgs())
    const tenantUuid = await tenantUuidOf('BREF-ANN-1')
    // The GSCB merge's shape: the default's code is rewritten in place by a
    // data repair, which is exactly the state the projection has to catch up to.
    await db.$executeRaw`UPDATE aggregator SET aggregator_code = '3', display_name = 'GSCB' WHERE tenant_id = ${tenantUuid}::uuid AND is_default`
    await db.$executeRawUnsafe('TRUNCATE outbox')

    const res = await announceDefaultAggregators(db, { traceId: 'tr' })

    expect(res.announced[0]!.aggregatorCode).toBe('3')
    const facts = await aggregatorFacts()
    expect(facts[0]).toMatchObject({ aggregatorCode: '3', displayName: 'GSCB' })
  })

  it('leaves the bank master list unchanged: this writes facts, not identity rows', async () => {
    await createBankMaster(db, bankArgs())
    const before = await listBankMasters(db)
    await announceDefaultAggregators(db, { traceId: 'tr' })
    const after = await listBankMasters(db)
    expect(after).toEqual(before)
  })
})
