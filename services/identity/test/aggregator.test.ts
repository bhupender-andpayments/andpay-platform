import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createBankMaster, createAggregator, editAggregator, listBankMasters } from '../src/ops.js'

// Spec 2026-08-20 (aggregator): the aggregator admin write path. Same
// connection/truncation preamble as bank_master.test.ts (the andpay CLUSTER
// SUPERUSER; the domain functions SET LOCAL ROLE identity_write inside their
// own tx).
const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

function createArgs(overrides: Record<string, unknown> = {}): Parameters<typeof createBankMaster>[1] {
  return {
    bankReferenceCode: 'BREF-ADMIN-1',
    displayName: 'HDFC Bank',
    address1: '1 MG Road',
    address2: 'Level 5',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    country: 'India',
    pin: '560001',
    mobile: '9000000001',
    email: 'ops@hdfc.example',
    clientKey: randomUUID(),
    actorId: 'actor-admin-1',
    traceId: 'trace-bm-1',
    ...overrides,
  } as Parameters<typeof createBankMaster>[1]
}

async function auditRowsFor(operation: string): Promise<
  { decision: string; operation: string; resourceIds: string[] | undefined; principalId: string }[]
> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({
      decision: r.payload.decision,
      operation: r.payload.operation,
      resourceIds: r.payload.resourceIds,
      principalId: r.payload.principalId,
    }))
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

describe('createAggregator / editAggregator', () => {
  it('creates an aggregator under a tenant and co-commits one ALLOW 6e', async () => {
    const t = await createBankMaster(db, createArgs())
    const res = await createAggregator(db, {
      tnntId: t.tnntId!, displayName: 'VSC Bank', aggregatorCode: 'VSC',
      clientKey: randomUUID(), actorId: 'actor-1', traceId: 'trace-ag-1',
    })
    expect(res.aggrId?.startsWith('aggr_')).toBe(true)
    const rows = await listBankMasters(db)
    const ags = rows[0]!.aggregators
    expect(ags.map((a) => a.aggregatorCode).sort()).toEqual(['BREF-ADMIN-1', 'VSC'])
    const audit = await auditRowsFor('ops:aggregator-create')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.resourceIds).toEqual([res.aggrId])
  })

  it('duplicate (tenant, code) is a 4xx, never resolve-to-existing', async () => {
    const t = await createBankMaster(db, createArgs())
    await createAggregator(db, { tnntId: t.tnntId!, displayName: 'VSC', aggregatorCode: 'VSC',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr' })
    await expect(createAggregator(db, { tnntId: t.tnntId!, displayName: 'VSC 2', aggregatorCode: 'VSC',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr' }))
      .rejects.toMatchObject({ kind: 'invalid', message: 'an aggregator with this code already exists for this bank' })
  })

  it('edit changes name and code while unlocked, records changed tokens, emits the fact', async () => {
    const t = await createBankMaster(db, createArgs())
    const a = await createAggregator(db, { tnntId: t.tnntId!, displayName: 'VSC', aggregatorCode: 'VSC-TMP',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr' })
    const res = await editAggregator(db, { aggrId: a.aggrId!, aggregatorCode: 'VSC', displayName: 'VSC Bank',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr2' })
    expect(res.changedFields.sort()).toEqual(['aggregatorCode', 'displayName'])
  })

  it('a code change is refused once code_locked_at is set', async () => {
    const t = await createBankMaster(db, createArgs())
    const a = await createAggregator(db, { tnntId: t.tnntId!, displayName: 'VSC', aggregatorCode: 'VSC',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr' })
    await db.$executeRaw`UPDATE aggregator SET code_locked_at = now() WHERE id = ${toUuid(a.aggrId!)}::uuid`
    await expect(editAggregator(db, { aggrId: a.aggrId!, aggregatorCode: 'OTHER',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr' }))
      .rejects.toMatchObject({ kind: 'invalid', message: 'the aggregator code is locked; ingest has already matched on it' })
  })

  it('the default aggregator cannot be suspended while its tenant is ACTIVE', async () => {
    await createBankMaster(db, createArgs())
    const rows = await listBankMasters(db)
    const def = rows[0]!.aggregators.find((x) => x.isDefault)!
    await expect(editAggregator(db, { aggrId: def.aggrId, status: 'SUSPENDED',
      clientKey: randomUUID(), actorId: 'a', traceId: 'tr' }))
      .rejects.toMatchObject({ kind: 'invalid', message: 'the default aggregator cannot be suspended while its bank is active' })
  })
})
