import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId } from '@andpay/ids'
import { merchantBankReference } from '@andpay/merchant-ref'
import { PrismaClient } from '../generated/client/index.js'
import { createBankMaster, createMerchant, OpsClientError } from '../src/ops.js'
import { projectRowFact } from '../src/project.js'
import { rowFactEnvelope, type RowFactPayload, type RowFactEnvelope } from '../src/row-fact.js'

// The ops Add-merchant write path (POST /ops/merchants), for the merchant no
// bank file has carried yet. Same connection posture as bank_master.test.ts:
// the andpay cluster superuser here, while the domain function enters
// identity_write inside its own tx, so the 6e co-commit and the grant path
// exercise the real non-owner role.
const url =
  process.env.IDENTITY_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const db = new PrismaClient({ datasourceUrl: url })

const BANK_REF = 'GSCB'
const VPA = 'sunrise@gscb'

async function seedBank(bankReferenceCode = BANK_REF): Promise<string> {
  const res = await createBankMaster(db, {
    bankReferenceCode,
    displayName: `${bankReferenceCode} Bank`,
    address1: '1 MG Road',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    country: 'India',
    pin: '560001',
    mobile: '9000000001',
    email: 'ops@bank.example',
    clientKey: randomUUID(),
    actorId: 'actor-admin-1',
    traceId: 'trace-bank-1',
  })
  return res.tnntId as string
}

function createArgs(tnntId: string, overrides: Record<string, unknown> = {}): Parameters<typeof createMerchant>[1] {
  return {
    tnntId,
    displayName: 'SUNRISE HARDWARE',
    legalName: 'Sunrise Hardware Pvt Ltd',
    mcc: '5251',
    vpa: VPA,
    contactName: 'Asha Rao',
    mobile: '9000000002',
    email: 'asha@sunrise.example',
    address: '12 Station Road',
    address2: 'Near the depot',
    city: 'Rajkot',
    state: 'Gujarat',
    pincode: '360001',
    clientKey: randomUUID(),
    actorId: 'actor-ops-1',
    traceId: 'trace-mc-1',
    ...overrides,
  } as Parameters<typeof createMerchant>[1]
}

interface OutboxRow {
  event_type: string
  payload: { payload?: Record<string, unknown>; decision?: string; operation?: string; resourceIds?: string[]; principalId?: string }
}

async function outboxRows(): Promise<OutboxRow[]> {
  return db.$queryRaw<OutboxRow[]>`SELECT event_type, payload FROM outbox ORDER BY created_at ASC`
}

async function factsOfType(type: string): Promise<Record<string, unknown>[]> {
  const rows = await outboxRows()
  return rows.filter((r) => r.event_type === type).map((r) => r.payload.payload ?? {})
}

function ingestRow(overrides: Partial<RowFactPayload> = {}, dedupKey = 'file-mc|1'): RowFactEnvelope {
  return rowFactEnvelope({
    payload: {
      // Exactly what the bank-file profile derives for this VPA.
      bankMerchantReference: merchantBankReference(VPA),
      displayName: 'SUNRISE HARDWARE',
      legalName: 'Sunrise Hardware Pvt Ltd',
      mcc: '5251',
      registeredAddress: '12 Station Road, Near the depot, Rajkot, Gujarat, 360001',
      bankReferenceCode: BANK_REF,
      productType: 'SOUNDBOX',
      vpaHint: VPA,
      ...overrides,
    },
    dedupKey,
    traceId: 'trace-ingest-1',
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
    'TRUNCATE aggregator, sub_merchant, merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox',
  )
})

describe('createMerchant (the ops Add-merchant path)', () => {
  it('mints the merchant, its default sub-merchant, the resolver row, the program and the enrollment', async () => {
    const tnntId = await seedBank()
    const res = await createMerchant(db, createArgs(tnntId))

    expect(res.deduped).toBe(false)
    expect(res.mrchId).toMatch(/^mrch_/)

    const merchants = await db.merchant.findMany()
    expect(merchants).toHaveLength(1)
    expect(merchants[0]!.displayName).toBe('SUNRISE HARDWARE')
    expect(merchants[0]!.activationState).toBe('PENDING')
    expect(merchants[0]!.status).toBe('ACTIVE')

    // The 3-tier model: exactly ONE default sub-merchant, same as ingest mints.
    expect(await db.subMerchant.count()).toBe(1)

    // The resolver row is the whole point: it is what the later bank file hits.
    const refs = await db.merchantBankRef.findMany()
    expect(refs).toHaveLength(1)
    expect(refs[0]!.bankMerchantReference).toBe(merchantBankReference(VPA))
    expect(refs[0]!.vpaHint).toBe(VPA)

    expect(await db.program.count()).toBe(1)
    expect(await db.enrollment.count()).toBe(1)
  })

  it('stores the contact and address block, and composes registered_address the way ingest does', async () => {
    const tnntId = await seedBank()
    await createMerchant(db, createArgs(tnntId))

    const m = (await db.merchant.findMany())[0]!
    expect(m.contactName).toBe('Asha Rao')
    expect(m.mobile).toBe('9000000002')
    expect(m.email).toBe('asha@sunrise.example')
    expect(m.city).toBe('Rajkot')
    expect(m.state).toBe('Gujarat')
    expect(m.pincode).toBe('360001')
    // The bank-file profile joins the same six parts with ', ' and drops the
    // empty ones, so a hand-created merchant and an ingested one describe one
    // address identically.
    expect(m.registeredAddress).toBe('12 Station Road, Near the depot, Rajkot, Gujarat, 360001')
  })

  it('emits MerchantCreated with the fact payload shape unchanged, and no contact on the bus', async () => {
    const tnntId = await seedBank()
    const res = await createMerchant(db, createArgs(tnntId))

    const facts = await factsOfType('fct.identity.merchant.v1')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toEqual({
      eventType: 'MerchantCreated',
      mrchId: res.mrchId,
      displayName: 'SUNRISE HARDWARE',
      legalName: 'Sunrise Hardware Pvt Ltd',
      mcc: '5251',
      registeredAddress: '12 Station Road, Near the depot, Rajkot, Gujarat, 360001',
      activationState: 'PENDING',
      status: 'ACTIVE',
    })
    // S7: the contact block stays in identity storage, never on a fact.
    const serialized = JSON.stringify(facts[0])
    expect(serialized).not.toContain('Asha Rao')
    expect(serialized).not.toContain('9000000002')
  })

  // A manual create has no bank-file row behind it, so there is no pending_row
  // for TMS to attach an assignment to. createAssignmentFromEnrollment THROWS
  // on a missing pending row, so emitting this fact would poison the consumer.
  it('does not emit the enrollment fact', async () => {
    const tnntId = await seedBank()
    await createMerchant(db, createArgs(tnntId))
    expect(await factsOfType('fct.identity.enrollment.v1')).toHaveLength(0)
  })

  it('co-commits the ALLOW 6e naming the new merchant, IDs only', async () => {
    const tnntId = await seedBank()
    const res = await createMerchant(db, createArgs(tnntId))

    const rows = await outboxRows()
    const audit = rows
      .filter((r) => r.event_type === 'authz.audit')
      .filter((r) => r.payload.operation === 'ops:merchant-create')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.payload.decision).toBe('ALLOW')
    expect(audit[0]!.payload.resourceIds).toEqual([res.mrchId])
    expect(audit[0]!.payload.principalId).toBe('actor-ops-1')
  })

  it('refuses a duplicate VPA for the same bank and leaves no partial row', async () => {
    const tnntId = await seedBank()
    await createMerchant(db, createArgs(tnntId))

    await expect(createMerchant(db, createArgs(tnntId, { displayName: 'A DIFFERENT SHOP' }))).rejects.toBeInstanceOf(
      OpsClientError,
    )

    expect(await db.merchant.count()).toBe(1)
    expect(await db.merchantBankRef.count()).toBe(1)
    // The rejected attempt burned no 6e: the whole tx rolled back.
    const audit = (await outboxRows()).filter((r) => r.payload.operation === 'ops:merchant-create')
    expect(audit).toHaveLength(1)
  })

  // Uniqueness is per-bank, at UNIQUE(tenant_id, bank_merchant_reference). It is
  // NOT the global "one merchant per VPA" that TASKLIST C-1 refused.
  it('allows the same VPA under a different bank', async () => {
    const first = await seedBank('GSCB')
    const second = await seedBank('OTHERBANK')

    const a = await createMerchant(db, createArgs(first))
    const b = await createMerchant(db, createArgs(second))

    expect(a.mrchId).not.toBe(b.mrchId)
    expect(await db.merchant.count()).toBe(2)
  })

  it('dedups a clientKey replay and mints nothing new', async () => {
    const tnntId = await seedBank()
    const args = createArgs(tnntId)

    const first = await createMerchant(db, args)
    const replay = await createMerchant(db, args)

    expect(first.deduped).toBe(false)
    expect(replay.deduped).toBe(true)
    expect(replay.mrchId).toBeNull()
    expect(await db.merchant.count()).toBe(1)
  })

  // THE LOAD-BEARING CASE. This is the whole reason the manual path writes the
  // resolver row rather than only the merchant.
  it('lands the later bank file on the SAME merchant, minting no second one', async () => {
    const tnntId = await seedBank()
    const created = await createMerchant(db, createArgs(tnntId))

    const result = await projectRowFact(db, ingestRow())
    expect(result.deduped).toBe(false)
    if (result.deduped) throw new Error('unreachable')

    expect(result.mrchId).toBe(created.mrchId)
    expect(result.mintedMerchant).toBe(false)
    expect(await db.merchant.count()).toBe(1)
    expect(await db.merchantBankRef.count()).toBe(1)

    // A reuse row never carries MerchantCreated (spec 05 fact hygiene), so the
    // only one in the outbox is the manual create's own.
    const created2 = await factsOfType('fct.identity.merchant.v1')
    expect(created2.filter((f) => f['eventType'] === 'MerchantCreated')).toHaveLength(1)
  })

  it('keeps the ingest row attachable: the enrollment fact still rides the bank file', async () => {
    const tnntId = await seedBank()
    await createMerchant(db, createArgs(tnntId))
    await projectRowFact(db, ingestRow())

    // The manual create emitted none; the file's row emits its own, carrying
    // the correlation id TMS attaches the assignment to.
    const enrollments = await factsOfType('fct.identity.enrollment.v1')
    expect(enrollments).toHaveLength(1)
    expect(enrollments[0]!['sourceEventId']).toBe('file-mc|1')
  })

  it('rejects a blank mandatory field as invalid', async () => {
    const tnntId = await seedBank()

    await expect(createMerchant(db, createArgs(tnntId, { displayName: '  ' }))).rejects.toMatchObject({
      kind: 'invalid',
    })
    await expect(createMerchant(db, createArgs(tnntId, { vpa: '' }))).rejects.toMatchObject({ kind: 'invalid' })

    expect(await db.merchant.count()).toBe(0)
  })

  // The two failure kinds are distinct answers and must not collapse: a
  // WELL-FORMED id for a bank that does not exist is not-found (404 at the
  // edge), a malformed id is invalid (400). Asserting only OpsClientError here
  // would pass even if every unknown bank came back as a validation error.
  it('separates an unknown bank from a malformed bank id', async () => {
    const unknown = newId('tnnt')
    await expect(createMerchant(db, createArgs(unknown))).rejects.toMatchObject({ kind: 'not-found' })

    await expect(createMerchant(db, createArgs('tnnt_not-a-real-id'))).rejects.toMatchObject({ kind: 'invalid' })

    expect(await db.merchant.count()).toBe(0)
  })
})
