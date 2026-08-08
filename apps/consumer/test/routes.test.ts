import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import type { Envelope } from '@andpay/envelope'
import { identityRoutes, groupIdFor, assertRowFactPayload } from '../src/routes.js'

// Relay plan step 2: the identity consumer, against the real database.
//
// The point is the WIRING, not the projection: projectRowFact is already proven
// by services/identity's own suite. What is new and worth pinning here is that
// the route reaches it, that a malformed fact is rejected at the boundary, and
// that at-least-once redelivery is absorbed.

const db = new IdentityClient({
  datasourceUrl:
    process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

const route = identityRoutes(db)

function rowFact(overrides: Record<string, unknown> = {}, dedupKey = 'file-consumer-1|1'): Envelope {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'fct.tms.bank_file_row.v1',
    version: 1,
    timestamp: '2026-08-08T18:00:00.000Z',
    subject: 'row-1',
    dedupKey,
    traceId: 'trace-consumer-test',
    payload: {
      bankMerchantReference: 'ZZCONSUMER001',
      displayName: 'ZZ Consumer Probe',
      legalName: 'ZZ CONSUMER PROBE PRIVATE LIMITED',
      mcc: '5411',
      registeredAddress: '1 Probe Street',
      bankReferenceCode: 'ZZBANK',
      productType: 'SOUNDBOX',
      ...overrides,
    },
  } as unknown as Envelope
}

async function cleanup(): Promise<void> {
  // Delete only what this file created, by its own marker. Never truncate:
  // identity tables carry other suites' fixtures and the demo seed.
  //
  // ORDER IS FK ORDER, and sub_merchant is the one that is easy to forget:
  // projectRowFact mints the 3-tier mrch_ -> smrch_ -> asgn_ chain, so a
  // merchant always has a sub_merchant hanging off it and deleting the merchant
  // first fails with sub_merchant_merchant_id_fkey.
  await db.$executeRawUnsafe(`
    DELETE FROM enrollment WHERE merchant_id IN (
      SELECT id FROM merchant WHERE display_name LIKE 'ZZ Consumer%'
    )`)
  await db.$executeRawUnsafe(`
    DELETE FROM sub_merchant WHERE merchant_id IN (
      SELECT id FROM merchant WHERE display_name LIKE 'ZZ Consumer%'
    )`)
  await db.$executeRawUnsafe(`DELETE FROM merchant_bank_ref WHERE bank_merchant_reference LIKE 'ZZCONSUMER%'`)
  await db.$executeRawUnsafe(`DELETE FROM merchant WHERE display_name LIKE 'ZZ Consumer%'`)
  await db.$executeRawUnsafe(`DELETE FROM inbox WHERE dedup_key LIKE 'file-consumer-%'`)
  // AND THE FACTS THIS TEST CAUSED TO BE EMITTED. projectRowFact is fact-in,
  // FACT-OUT: it writes merchant/tenant/program/enrollment facts to the outbox
  // in the same transaction. Deleting only the projected rows leaves those
  // facts behind, and the demo pump then drains them and dead-letters every
  // enrollment with "pending row not found", because the matching TMS
  // pending_row never existed. Observed exactly that in the live environment.
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE payload::text LIKE '%ZZ Consumer%'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE payload->>'dedupKey' LIKE 'file-consumer-%'`)
}

beforeEach(cleanup)
afterAll(async () => {
  await cleanup()
  await db.$disconnect()
})

describe('identity consumer route', () => {
  it('subscribes to the bank row fact, which TMS produces and IDENTITY consumes', () => {
    // The topic namespace names the PRODUCER; the consumer is chosen by the
    // write destination. Getting this backwards is the easy mistake.
    expect(route.topics).toEqual(['fct.tms.bank_file_row.v1'])
  })

  it('uses a context-scoped, version-pinned group id (ruling A-6.3)', () => {
    expect(groupIdFor('identity')).toBe('andpay.identity.v1')
    expect(groupIdFor('fulfillment')).toBe('andpay.fulfillment.v1')
  })

  it('projects a row fact into a real merchant', async () => {
    await route.handle(rowFact())
    const rows = await db.$queryRawUnsafe<{ display_name: string }[]>(
      `SELECT display_name FROM merchant WHERE display_name = 'ZZ Consumer Probe'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('absorbs at-least-once redelivery: the same fact twice yields ONE merchant', async () => {
    // Kafka delivery is at-least-once by design (E2), so this is the normal
    // case, not an edge case. projectRowFact is E6-guarded on the dedupKey.
    const env = rowFact()
    await route.handle(env)
    await route.handle(env)
    const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM merchant WHERE display_name = 'ZZ Consumer Probe'`,
    )
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('rejects a malformed fact AT THE BOUNDARY, naming the missing field', async () => {
    // Without this the row would reach the projection as undefined values and
    // fail somewhere far less legible, or write a row built from nothing.
    await expect(route.handle(rowFact({ displayName: undefined }))).rejects.toThrow(/displayName/)
  })

  it('names every missing field at once, not just the first', () => {
    expect(() => { assertRowFactPayload(rowFact({ mcc: undefined, legalName: undefined })) })
      .toThrow(/legalName, mcc|mcc, legalName/)
  })

  it('rejects a non-object payload rather than throwing deep inside', () => {
    const bad = { ...rowFact(), payload: 'not an object' } as unknown as Envelope
    expect(() => { assertRowFactPayload(bad) }).toThrow(/payload must be an object/)
  })
})
