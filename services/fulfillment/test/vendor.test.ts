import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { parseId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { createVendor } from '../src/vendor.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE vndr, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

describe('createVendor (class-3 ops action, D115)', () => {
  it('mints a vndr_ id, inserts a vndr row (type MANUFACTURER, status ACTIVE), and sets updated_at', async () => {
    const { vndrId } = await createVendor(
      db,
      { type: 'MANUFACTURER', displayName: 'Acme Devices' },
      { operatorId: 'op-1' },
      'trace-1',
    )

    expect(() => parseId('vndr', vndrId)).not.toThrow()

    const rows = await db.$queryRaw<
      { id: string; type: string; display_name: string; status: string; updated_at: Date | null }[]
    >`SELECT id, type, display_name, status, updated_at FROM vndr WHERE id = ${toUuid(vndrId)}::uuid`

    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('MANUFACTURER')
    expect(rows[0]!.display_name).toBe('Acme Devices')
    expect(rows[0]!.status).toBe('ACTIVE')
    expect(rows[0]!.updated_at).not.toBeNull()
  })

  it('Phase 3 Task 2 (BRD FR-11): a COURIER create with courierCode + integrationMode inserts both columns', async () => {
    const courierCode = `crt-${randomUUID().slice(0, 8)}`
    const { vndrId } = await createVendor(
      db,
      { type: 'COURIER', displayName: 'Speedy Couriers', courierCode, integrationMode: 'batch' },
      { operatorId: 'op-1' },
      'trace-2',
    )

    const rows = await db.$queryRaw<
      { courier_code: string | null; integration_mode: string | null }[]
    >`SELECT courier_code, integration_mode FROM vndr WHERE id = ${toUuid(vndrId)}::uuid`
    expect(rows[0]!.courier_code).toBe(courierCode)
    expect(rows[0]!.integration_mode).toBe('batch')
  })
})
