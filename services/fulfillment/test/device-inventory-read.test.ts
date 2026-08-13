import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { listDeviceInventory } from '../src/ops-read.js'

// THE MISSING TEST, added 13 Aug 2026 after T4.4 broke this read and shipped.
//
// listDeviceInventory runs under fulfillment_ops_read, whose grant on `unit` is
// COLUMN-SCOPED (migration 20260810020000) and therefore does NOT extend to
// columns added later. T4.4 added activated_at, the read started selecting it,
// and every GET /ops/devices began failing with "permission denied for table
// unit" -- the whole screen, not just the new column. It reached the gate
// because nothing exercised this function against the real role: the portal
// suite mocks fetch, and the only check on that grant was the migration file
// agreeing with itself.
//
// So this suite's job is narrow and load-bearing: run the REAL query under the
// REAL role. Any future column added to the select without its grant fails here
// instead of in production.
const url =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const VNDR = toUuid(newId('vndr'))

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE unit CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedUnit(opts: { status?: string; activatedAt?: Date | null } = {}): Promise<string> {
  const unitUuid = toUuid(newId('unit'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, sim_no, activated_at, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${VNDR}::uuid, ${opts.status ?? 'IN_STOCK'},
            ${`SER-${randomUUID()}`}, ${`ICCID-${randomUUID()}`}, ${opts.activatedAt ?? null}::timestamptz, now())
  `
  return unitUuid
}

describe('listDeviceInventory under the real ops read role', () => {
  it('reads every column it selects, including the activation axis', async () => {
    const at = new Date('2026-08-13T10:00:00.000Z')
    await seedUnit({ status: 'DISPATCHED', activatedAt: at })

    const rows = await listDeviceInventory(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('DISPATCHED')
    // The two axes, side by side, which is the whole of D-16 on this row.
    expect(rows[0]!.activatedAt).toEqual(at)
  })

  it('the status filter path reads the same columns, not a narrower set', async () => {
    // A separate code path with its own SELECT list, so a grant fix applied to
    // only one of the two would pass the test above and still break in
    // production the moment an operator used the filter.
    await seedUnit({ status: 'DELIVERED', activatedAt: new Date('2026-08-13T10:00:00.000Z') })
    await seedUnit({ status: 'IN_STOCK' })

    const rows = await listDeviceInventory(db, { status: 'DELIVERED' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.activatedAt).not.toBeNull()
  })

  it('a not-yet-activated device reports null rather than failing to read', async () => {
    await seedUnit({ status: 'IN_STOCK' })
    const rows = await listDeviceInventory(db)
    expect(rows[0]!.activatedAt).toBeNull()
  })

  it('the ICCID stays UNREADABLE to this role: the exclusion is by grant, not by omission (S7)', async () => {
    await seedUnit()
    // The read above works, so the role is fine. Naming sim_no in a select under
    // the same role must still fail, which is what makes "excluded by grant"
    // a guarantee rather than a convention somebody could quietly drop.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
        return tx.$queryRaw`SELECT sim_no FROM unit`
      }),
    ).rejects.toThrow()
  })
})
