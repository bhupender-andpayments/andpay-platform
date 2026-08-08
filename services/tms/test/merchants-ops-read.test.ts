import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import { listMerchants } from '../src/ops-read.js'
import { newId, toUuid } from '@andpay/ids'

// Redesign step 7 (ruling 1b): the class-3 ops Merchants list.
//
// merchant_projection is a PROJECTION other TMS test files write through
// projectMerchantFact, so this file never truncates it. Every row it creates is
// deleted BY ID in a finally, the same convention damage-reason.test.ts uses for
// the reference master, and every assertion filters to this file's own rows so a
// projection row left by another file cannot make it pass or fail.
const url = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

interface Seeded {
  wire: string
  uuid: string
}

async function seedMerchant(opts: {
  displayName: string
  legalName?: string
  mcc?: string
  status?: string
}): Promise<Seeded> {
  const wire = newId('mrch')
  const uuid = toUuid(wire)
  await db.$executeRaw`
    INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
    VALUES (
      ${uuid}::uuid, ${opts.displayName}, ${opts.legalName ?? 'LEGAL ' + opts.displayName},
      ${opts.mcc ?? '5411'}, ${opts.status ?? 'ACTIVE'}, now()
    )
  `
  return { wire, uuid }
}

async function removeMerchants(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.$executeRaw`DELETE FROM merchant_projection WHERE id = ${id}::uuid`
  }
}

describe('listMerchants: the ops Merchants list (redesign step 7)', () => {
  it('reads under tms_ops_read at all, which is what the new GRANT buys', async () => {
    // THE POINT OF THIS ASSERTION. listMerchants does SET LOCAL ROLE
    // tms_ops_read, and before migration 20260808190000 that role had no grant
    // on merchant_projection, so this call raised a Postgres permission-denied
    // rather than returning an empty list. Revoke the grant and this fails.
    await expect(listMerchants(db)).resolves.toBeInstanceOf(Array)
  })

  it('emits the WIRE id, never the raw uuid (D-A)', async () => {
    const m = await seedMerchant({ displayName: 'ZZ WIRE ID PROBE' })
    try {
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row, 'the seeded merchant must be listed').toBeDefined()
      expect(row?.mrchId).toMatch(/^mrch_/)
      expect(JSON.stringify(row)).not.toContain(m.uuid)
    } finally {
      await removeMerchants([m.uuid])
    }
  })

  it('orders by the name a human calls the merchant, not by arrival', async () => {
    // Seeded in the WRONG order on purpose, so passing cannot be an accident of
    // insertion order.
    const c = await seedMerchant({ displayName: 'ZZ ORDER CHARLIE' })
    const a = await seedMerchant({ displayName: 'ZZ ORDER ALPHA' })
    const b = await seedMerchant({ displayName: 'ZZ ORDER BRAVO' })
    try {
      const mine = (await listMerchants(db))
        .filter((r) => r.displayName.startsWith('ZZ ORDER '))
        .map((r) => r.displayName)
      expect(mine).toEqual(['ZZ ORDER ALPHA', 'ZZ ORDER BRAVO', 'ZZ ORDER CHARLIE'])
    } finally {
      await removeMerchants([a.uuid, b.uuid, c.uuid])
    }
  })

  it('returns SUSPENDED merchants too, so a search cannot silently hide one', async () => {
    // A merchant search that omits suspended merchants sends the operator
    // looking for a record that does exist. This is the same failure mode that
    // got option 1c rejected.
    const active = await seedMerchant({ displayName: 'ZZ STATUS ACTIVE', status: 'ACTIVE' })
    const susp = await seedMerchant({ displayName: 'ZZ STATUS SUSPENDED', status: 'SUSPENDED' })
    try {
      const mine = (await listMerchants(db)).filter((r) => r.displayName.startsWith('ZZ STATUS '))
      expect(mine.map((r) => r.status).sort()).toEqual(['ACTIVE', 'SUSPENDED'])
    } finally {
      await removeMerchants([active.uuid, susp.uuid])
    }
  })

  it('carries the fields the screen needs and NOTHING else (D104 default-exclude)', async () => {
    const m = await seedMerchant({ displayName: 'ZZ SHAPE PROBE', legalName: 'ZZ SHAPE LEGAL', mcc: '5812' })
    try {
      const row = (await listMerchants(db)).find((r) => r.mrchId === m.wire)
      expect(row).toBeDefined()
      // An EXACT key set, not a subset check: a future column added to
      // merchant_projection cannot reach the wire unnoticed.
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'displayName',
        'legalName',
        'mcc',
        'mrchId',
        'status',
        'updatedAt',
      ])
      expect(row?.legalName).toBe('ZZ SHAPE LEGAL')
      expect(row?.mcc).toBe('5812')
    } finally {
      await removeMerchants([m.uuid])
    }
  })
})
