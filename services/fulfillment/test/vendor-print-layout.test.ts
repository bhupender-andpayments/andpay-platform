import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { setVendorPrintLayout, OpsClientError } from '../src/ops.js'

// Task 12 (W-6): the PRINT vendor print_layout admin write, mirroring
// batching-config.test.ts's direct-function shape (the HTTP authz
// differentiation lives in apps/ops-edge/test, not here).
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE vndr, outbox, inbox CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedVendor(type: string, printLayout = 'ONE_PER_PAGE'): Promise<string> {
  const vndrWire = newId('vndr')
  const vndrUuid = toUuid(vndrWire)
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, print_layout, updated_at)
    VALUES (${vndrUuid}::uuid, ${type}, 'Press Co', 'ACTIVE', ${printLayout}, now())
  `
  return vndrWire
}

async function readPrintLayout(vndrWire: string): Promise<string> {
  const rows = await db.$queryRaw<{ print_layout: string }[]>`
    SELECT print_layout FROM vndr WHERE id = ${toUuid(vndrWire)}::uuid
  `
  expect(rows).toHaveLength(1)
  return rows[0]!.print_layout
}

async function auditRowsFor(operation: string): Promise<{ decision: string; resourceIds: string[]; principalId: string }[]> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [], principalId: r.payload.principalId }))
}

describe('setVendorPrintLayout (Task 12, W-6, audited admin write)', () => {
  it('a valid call on a PRINT vendor flips the column, returns { deduped: false }, and co-commits ONE ALLOW 6e with old/new', async () => {
    const vndrWire = await seedVendor('PRINT', 'ONE_PER_PAGE')
    const actorId = randomUUID()

    const res = await setVendorPrintLayout(db, {
      vndrId: vndrWire,
      layout: 'GRID_3X2',
      clientKey: randomUUID(),
      actorId,
      traceId: 't-pl-1',
    })
    expect(res).toEqual({ deduped: false })

    expect(await readPrintLayout(vndrWire)).toBe('GRID_3X2')

    const rows = await auditRowsFor('ops:vendor-print-layout-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.principalId).toBe(actorId)
    expect(rows[0]!.resourceIds).toEqual([vndrWire, 'print-layout:old=ONE_PER_PAGE:new=GRID_3X2'])
  })

  it('a second write audits the PRIOR value as old', async () => {
    const vndrWire = await seedVendor('PRINT', 'ONE_PER_PAGE')
    await setVendorPrintLayout(db, {
      vndrId: vndrWire,
      layout: 'GRID_3X2',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-pl-2a',
    })
    await setVendorPrintLayout(db, {
      vndrId: vndrWire,
      layout: 'ONE_PER_PAGE',
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-pl-2b',
    })

    expect(await readPrintLayout(vndrWire)).toBe('ONE_PER_PAGE')
    const rows = await auditRowsFor('ops:vendor-print-layout-set')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.resourceIds).toEqual([vndrWire, 'print-layout:old=GRID_3X2:new=ONE_PER_PAGE'])
  })

  it('a replay (same clientKey) is deduped, leaves the column unchanged past the first write, and emits no second 6e', async () => {
    const vndrWire = await seedVendor('PRINT')
    const clientKey = randomUUID()
    const args = { vndrId: vndrWire, layout: 'GRID_3X2', clientKey, actorId: randomUUID(), traceId: 't-pl-3' }

    const first = await setVendorPrintLayout(db, args)
    expect(first.deduped).toBe(false)
    const replay = await setVendorPrintLayout(db, { ...args, actorId: randomUUID() })
    expect(replay.deduped).toBe(true)

    expect(await readPrintLayout(vndrWire)).toBe('GRID_3X2')
    expect(await auditRowsFor('ops:vendor-print-layout-set')).toHaveLength(1)
  })

  it('an invalid layout string throws OpsClientError(invalid), burns no clientKey, and emits no 6e', async () => {
    const vndrWire = await seedVendor('PRINT')
    const clientKey = randomUUID()

    await expect(
      setVendorPrintLayout(db, {
        vndrId: vndrWire,
        layout: 'TRIPLICATE',
        clientKey,
        actorId: randomUUID(),
        traceId: 't-pl-4',
      }),
    ).rejects.toBeInstanceOf(OpsClientError)
    await expect(
      setVendorPrintLayout(db, {
        vndrId: vndrWire,
        layout: 'TRIPLICATE',
        clientKey,
        actorId: randomUUID(),
        traceId: 't-pl-4',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    expect(await readPrintLayout(vndrWire)).toBe('ONE_PER_PAGE')
    expect(await auditRowsFor('ops:vendor-print-layout-set')).toHaveLength(0)

    // The clientKey was never burned by the rejected (pre-transaction)
    // attempt, so a valid retry on the SAME clientKey still runs.
    const retry = await setVendorPrintLayout(db, {
      vndrId: vndrWire,
      layout: 'GRID_3X2',
      clientKey,
      actorId: randomUUID(),
      traceId: 't-pl-4b',
    })
    expect(retry.deduped).toBe(false)
  })

  it('targeting a non-PRINT vendor (COURIER) throws OpsClientError(invalid), leaves the row untouched, and emits no 6e', async () => {
    const vndrWire = await seedVendor('COURIER')

    await expect(
      setVendorPrintLayout(db, {
        vndrId: vndrWire,
        layout: 'GRID_3X2',
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-pl-5',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    expect(await readPrintLayout(vndrWire)).toBe('ONE_PER_PAGE')
    expect(await auditRowsFor('ops:vendor-print-layout-set')).toHaveLength(0)
  })

  it('targeting a non-PRINT vendor (MANUFACTURER) throws OpsClientError(invalid)', async () => {
    const vndrWire = await seedVendor('MANUFACTURER')
    await expect(
      setVendorPrintLayout(db, {
        vndrId: vndrWire,
        layout: 'GRID_3X2',
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-pl-6',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('an unknown vndrId throws OpsClientError(invalid) and burns no clientKey (no 6e)', async () => {
    await expect(
      setVendorPrintLayout(db, {
        vndrId: newId('vndr'),
        layout: 'GRID_3X2',
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-pl-7',
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })

    expect(await auditRowsFor('ops:vendor-print-layout-set')).toHaveLength(0)
  })

  it('a fresh PRINT vendor defaults to ONE_PER_PAGE via the DB DEFAULT (no explicit column on insert)', async () => {
    const vndrWire = newId('vndr')
    const vndrUuid = toUuid(vndrWire)
    await db.$executeRaw`
      INSERT INTO vndr (id, type, display_name, status, updated_at)
      VALUES (${vndrUuid}::uuid, 'PRINT', 'Press Co 2', 'ACTIVE', now())
    `
    expect(await readPrintLayout(vndrWire)).toBe('ONE_PER_PAGE')
  })
})
