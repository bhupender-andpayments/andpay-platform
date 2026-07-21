import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { enqueue } from '@andpay/outbox'
import { PrismaClient } from '../generated/client/index.js'
import { projectRowFact } from '../src/project.js'
import { rowFactEnvelope, type RowFactPayload, type RowFactEnvelope } from '../src/row-fact.js'
import { merchantFactEnvelope, IDENTITY_MERCHANT_TOPIC, IDENTITY_ENROLLMENT_TOPIC } from '../src/events.js'

const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

function row(
  overrides: Partial<RowFactPayload> = {},
  dedupKey = 'file1|1',
  traceId = 'trace-1',
): RowFactEnvelope {
  return rowFactEnvelope({
    payload: {
      bankMerchantReference: 'BREF-1',
      displayName: 'Acme Traders',
      legalName: 'Acme Pvt Ltd',
      mcc: '5411',
      registeredAddress: '221B Baker Street',
      bankReferenceCode: 'BRD',
      productType: 'soundbox_dispatch',
      vpaHint: 'acme@brd',
      ...overrides,
    },
    dedupKey,
    traceId,
  })
}

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox',
  )
})

describe('consume-project-emit (spec 05, check 1 resolution and dedup)', () => {
  it('1(a): a first row creates one merchant, one resolver row, one enrollment, four facts', async () => {
    const res = await projectRowFact(db, row())
    expect(res.deduped).toBe(false)
    if (res.deduped) return
    expect(res.mrchId.startsWith('mrch_')).toBe(true)
    expect(res.mintedMerchant).toBe(true)
    expect(await db.merchant.count()).toBe(1)
    expect(await db.merchantBankRef.count()).toBe(1)
    expect(await db.enrollment.count()).toBe(1)
    expect(await db.tenant.count()).toBe(1)
    expect(await db.program.count()).toBe(1)
    expect(await db.outbox.count()).toBe(4)
  })

  it('1(b): a redelivered identical row is a no-op (inbox dedup, no duplicate fact)', async () => {
    await projectRowFact(db, row({}, 'file1|1'))
    const before = {
      m: await db.merchant.count(),
      r: await db.merchantBankRef.count(),
      e: await db.enrollment.count(),
      o: await db.outbox.count(),
    }
    const res = await projectRowFact(db, row({}, 'file1|1')) // same dedupKey
    expect(res.deduped).toBe(true)
    expect(await db.merchant.count()).toBe(before.m)
    expect(await db.merchantBankRef.count()).toBe(before.r)
    expect(await db.enrollment.count()).toBe(before.e)
    expect(await db.outbox.count()).toBe(before.o)
  })

  it('1(c): a second row for the same (tenant, reference) under the same Program reuses the mrch_', async () => {
    const first = await projectRowFact(db, row({}, 'file1|1'))
    const second = await projectRowFact(db, row({}, 'file1|2'))
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(false)
    if (!first.deduped && !second.deduped) expect(second.mrchId).toBe(first.mrchId)
    expect(await db.merchant.count()).toBe(1)
    expect(await db.merchantBankRef.count()).toBe(1)
    expect(await db.enrollment.count()).toBe(1)
  })

  it('1(d): the same merchant under a NEW Program creates a new enrollment, no new mrch_', async () => {
    const first = await projectRowFact(db, row({ productType: 'soundbox_dispatch' }, 'file1|1'))
    const second = await projectRowFact(db, row({ productType: 'pos_terminal' }, 'file2|1'))
    expect(second.deduped).toBe(false)
    if (!first.deduped && !second.deduped) expect(second.mrchId).toBe(first.mrchId)
    expect(await db.merchant.count()).toBe(1) // no new merchant
    expect(await db.merchantBankRef.count()).toBe(1) // no new resolver row
    expect(await db.program.count()).toBe(2) // two Programs
    expect(await db.enrollment.count()).toBe(2) // two enrollments
  })

  it('1(e): concurrent first-seen rows for the same (tenant, reference) fail closed to one mrch_', async () => {
    const results = await Promise.all([
      projectRowFact(db, row({}, 'file1|1')),
      projectRowFact(db, row({}, 'file2|1')),
    ])
    expect(await db.merchant.count()).toBe(1)
    expect(await db.merchantBankRef.count()).toBe(1)
    const mrchIds = results.filter((r) => !r.deduped).map((r) => (r as { mrchId: string }).mrchId)
    expect(mrchIds.length).toBe(2)
    expect(new Set(mrchIds).size).toBe(1) // both resolved to the same mrch_
  })

  it('1(e): the resolver UNIQUE is a real DB boundary (a raw duplicate insert raises a unique violation)', async () => {
    await projectRowFact(db, row({}, 'file1|1'))
    const ref = await db.merchantBankRef.findFirstOrThrow()
    await expect(
      db.$executeRaw`INSERT INTO merchant_bank_ref (tenant_id, bank_merchant_reference, merchant_id) VALUES (${ref.tenantId}::uuid, ${ref.bankMerchantReference}, gen_random_uuid())`,
    ).rejects.toThrow()
  })
})

describe('consume-project-emit (spec 05, checks 3, 5, 7, 8, 9)', () => {
  it('3: two rows sharing a VPA but differing by reference produce two merchants (VPA is a hint, not identity)', async () => {
    await projectRowFact(db, row({ bankMerchantReference: 'BREF-A', vpaHint: 'shared@brd' }, 'file1|1'))
    await projectRowFact(db, row({ bankMerchantReference: 'BREF-B', vpaHint: 'shared@brd' }, 'file1|2'))
    expect(await db.merchant.count()).toBe(2)
    expect(await db.merchantBankRef.count()).toBe(2)
    expect(await db.enrollment.count()).toBe(2)
  })

  it('5: merchant and enrollment facts are partition-keyed by the mrch_ id (E5)', async () => {
    const res = await projectRowFact(db, row())
    if (res.deduped) throw new Error('unexpected dedupe')
    const merchant = await db.outbox.findFirstOrThrow({ where: { eventType: IDENTITY_MERCHANT_TOPIC } })
    const enrollment = await db.outbox.findFirstOrThrow({ where: { eventType: IDENTITY_ENROLLMENT_TOPIC } })
    expect(merchant.partitionKey).toBe(res.mrchId)
    expect(enrollment.partitionKey).toBe(res.mrchId)
  })

  it('7: E1, the merchant write and its fact enqueue roll back together', async () => {
    await expect(
      db.$transaction(async (tx) => {
        const mrch = toUuid(newId('mrch'))
        await tx.merchant.create({
          data: {
            id: mrch,
            displayName: 'X',
            legalName: 'X',
            mcc: '0000',
            registeredAddress: 'a',
            activationState: 'PENDING',
            status: 'ACTIVE',
          },
        })
        const env = merchantFactEnvelope({
          payload: {
            eventType: 'MerchantCreated',
            mrchId: fromUuid('mrch', mrch),
            displayName: 'X',
            legalName: 'X',
            mcc: '0000',
            registeredAddress: 'a',
            activationState: 'PENDING',
            status: 'ACTIVE',
          },
          dedupKey: 'k',
          traceId: 't',
        })
        await enqueue(tx, {
          aggregateType: 'merchant',
          aggregateId: fromUuid('mrch', mrch),
          eventType: IDENTITY_MERCHANT_TOPIC,
          partitionKey: fromUuid('mrch', mrch),
          payload: env,
        })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await db.merchant.count()).toBe(0)
    expect(await db.outbox.count()).toBe(0)
  })

  it('7: E1, a successful projection commits the merchant and all four facts together', async () => {
    const res = await projectRowFact(db, row())
    expect(res.deduped).toBe(false)
    expect(await db.merchant.count()).toBe(1)
    expect(await db.outbox.count()).toBe(4)
  })

  it('8: the sponsor bank is minted as a tnnt_, never a bank_ (D116, I5)', async () => {
    const res = await projectRowFact(db, row())
    if (res.deduped) throw new Error('unexpected dedupe')
    expect(res.tnntId.startsWith('tnnt_')).toBe(true)
    expect(res.progId.startsWith('prog_')).toBe(true)
    const outbox = await db.outbox.findMany()
    expect(JSON.stringify(outbox).includes('bank_')).toBe(false)
  })

  it('9: the row fact trace_id appears on all four emitted facts (S21)', async () => {
    await projectRowFact(db, row({}, 'file1|1', 'trace-xyz'))
    const outbox = await db.outbox.findMany()
    expect(outbox).toHaveLength(4)
    for (const o of outbox) {
      expect((o.payload as { traceId: string }).traceId).toBe('trace-xyz')
    }
  })
})

type FactRow = { eventType: string; payload: unknown }
const topicsOf = (facts: FactRow[]): string[] => facts.map((f) => f.eventType).sort()
const merchantEventType = (facts: FactRow[]): string | undefined => {
  const m = facts.find((f) => f.eventType === IDENTITY_MERCHANT_TOPIC)
  return m ? (m.payload as { payload: { eventType: string } }).payload.eventType : undefined
}

describe('fact hygiene: emit on change, always enrollment (spec 05)', () => {
  it('a create row emits all four facts with MerchantCreated', async () => {
    await projectRowFact(db, row({}, 'file1|1'))
    const facts = await db.outbox.findMany()
    expect(topicsOf(facts)).toEqual([
      'fct.identity.enrollment.v1',
      'fct.identity.merchant.v1',
      'fct.identity.program.v1',
      'fct.identity.tenant.v1',
    ])
    expect(merchantEventType(facts)).toBe('MerchantCreated')
  })

  it('a no-change reuse row emits ONLY the enrollment fact (suppresses tenant/program/merchant)', async () => {
    await projectRowFact(db, row({}, 'file1|1'))
    await db.$executeRawUnsafe('TRUNCATE outbox')
    await projectRowFact(db, row({}, 'file1|2'))
    const facts = await db.outbox.findMany()
    expect(topicsOf(facts)).toEqual(['fct.identity.enrollment.v1'])
    expect(merchantEventType(facts)).toBeUndefined()
  })

  it('a new-Program reuse emits program and enrollment only (no tenant, no merchant)', async () => {
    await projectRowFact(db, row({ productType: 'soundbox_dispatch' }, 'file1|1'))
    await db.$executeRawUnsafe('TRUNCATE outbox')
    await projectRowFact(db, row({ productType: 'pos_terminal' }, 'file2|1'))
    const facts = await db.outbox.findMany()
    expect(topicsOf(facts)).toEqual(['fct.identity.enrollment.v1', 'fct.identity.program.v1'])
  })

  it('a field-diff reuse updates the merchant and emits MerchantUpdated plus enrollment', async () => {
    const first = await projectRowFact(db, row({ displayName: 'Acme Traders' }, 'file1|1'))
    if (first.deduped) throw new Error('unexpected dedupe')
    await db.$executeRawUnsafe('TRUNCATE outbox')
    await projectRowFact(db, row({ displayName: 'Acme Traders LLP' }, 'file1|2'))
    const facts = await db.outbox.findMany()
    expect(topicsOf(facts)).toEqual(['fct.identity.enrollment.v1', 'fct.identity.merchant.v1'])
    expect(merchantEventType(facts)).toBe('MerchantUpdated')
    const stored = await db.merchant.findUniqueOrThrow({ where: { id: toUuid(first.mrchId) } })
    expect(stored.displayName).toBe('Acme Traders LLP')
  })

  it('always emits the enrollment fact carrying this row source correlation id', async () => {
    await projectRowFact(db, row({}, 'file1|1'))
    await db.$executeRawUnsafe('TRUNCATE outbox')
    await projectRowFact(db, row({}, 'file7|9'))
    const enr = await db.outbox.findFirstOrThrow({ where: { eventType: IDENTITY_ENROLLMENT_TOPIC } })
    expect((enr.payload as { payload: { sourceEventId: string } }).payload.sourceEventId).toBe('file7|9')
  })

  it('a reuse row never carries MerchantCreated', async () => {
    await projectRowFact(db, row({}, 'file1|1'))
    await db.$executeRawUnsafe('TRUNCATE outbox')
    await projectRowFact(db, row({ displayName: 'Changed Co' }, 'file1|2'))
    const facts = await db.outbox.findMany()
    expect(merchantEventType(facts)).not.toBe('MerchantCreated')
  })
})
