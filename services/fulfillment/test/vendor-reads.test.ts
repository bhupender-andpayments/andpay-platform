import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readVendorWorkQueue, readVendorHistory } from '../src/vendor-reads.js'

// Spec 14b Task 3: the vendor work-queue read, running under
// fulfillment_vendor_read (Task 2's role plus RESTRICTIVE vndr-axis RLS).
// Proves own-vndr scoping at the application level (the projection/join),
// with Task 2's vendor-read-rls.test.ts already proving the DB-level RLS
// backstop directly. Also proves the projection is PII-free by construction
// (Object.keys, not just a spot-check of individual fields).
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, pending_pool_entry, batch, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

interface Seeded {
  btchV1Uuid: string
  btchV1Wire: string
  v1Wire: string
}

// Seeds B1 (print_vndr=V1) with two pending_pool_entry rows (one
// dispatch_state=NULL i.e. QR_GENERATED-not-yet-set, one SENT_TO_VENDOR; both
// still open, i.e. not DISPATCHED_BY_VENDOR), and B2 (print_vndr=V2) with one
// open entry, to prove V1's work-queue never surfaces B2.
async function seed(): Promise<Seeded> {
  const v1Wire = newId('vndr')
  const v1Uuid = toUuid(v1Wire)
  const v2Uuid = toUuid(newId('vndr'))
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))

  const btchV1Wire = newId('btch')
  const btchV1Uuid = toUuid(btchV1Wire)
  const btchV2Uuid = toUuid(newId('btch'))

  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV1Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v1Uuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 2, now())
  `
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV2Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v2Uuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `

  const entryV1A = toUuid(newId('asgn'))
  const entryV1B = toUuid(newId('asgn'))
  const entryV2 = toUuid(newId('asgn'))

  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV1A}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      '1 Main St', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${btchV1Uuid}::uuid, NULL, 'evt-1', 'trace-1', now()
    )
  `
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV1B}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store 2', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      '1 Main St', 'acme2@hdfcbank', 'acme2@hdfcbank', 'BATCHED', ${btchV1Uuid}::uuid, 'SENT_TO_VENDOR', 'evt-1b', 'trace-1b', now()
    )
  `
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
    ) VALUES (
      ${entryV2}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Beta Store', 'Beta Pvt Ltd', '5814', 'HDFC-002', 'HDFC Bank',
      '2 Main St', 'beta@hdfcbank', 'beta@hdfcbank', 'BATCHED', ${btchV2Uuid}::uuid, NULL, 'evt-2', 'trace-2', now()
    )
  `

  return { btchV1Uuid, btchV1Wire: fromUuid('btch', btchV1Uuid), v1Wire }
}

describe('readVendorWorkQueue (spec 14b task 3)', () => {
  it('work-queue lists own-vndr batches with open (not-yet-dispatched) entries, PII-free', async () => {
    const { btchV1Wire, v1Wire } = await seed()

    const rows = await readVendorWorkQueue(db, v1Wire)

    expect(rows.map((r) => r.btchId)).toEqual([btchV1Wire])
    expect(rows[0]!.openEntries).toBe(2)
    // PII-free: the row type has no ship_to* keys at all.
    expect(Object.keys(rows[0]!)).toEqual(['btchId', 'unitCount', 'status', 'openEntries', 'createdAt'])
  })
})

interface HistorySeeded {
  btchV1Wire: string
  v1Wire: string
  awb: string
}

// Seeds B1 (print_vndr=V1) with a dispatched unit (unit.shipment -> shpt,
// awb 'AWB1', status DISPATCHED_BY_VENDOR), and B2 (print_vndr=V2) with its
// own dispatched unit, to prove V1's history never surfaces V2's dispatch.
async function seedHistory(): Promise<HistorySeeded> {
  const v1Wire = newId('vndr')
  const v1Uuid = toUuid(v1Wire)
  const v2Uuid = toUuid(newId('vndr'))
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))

  const btchV1Wire = newId('btch')
  const btchV1Uuid = toUuid(btchV1Wire)
  const btchV2Uuid = toUuid(newId('btch'))

  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV1Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v1Uuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchV2Uuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${v2Uuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `

  const shptV1Uuid = toUuid(newId('shpt'))
  const shptV2Uuid = toUuid(newId('shpt'))
  const dispatchDate = new Date('2026-08-01T10:00:00.000Z')

  await db.$executeRaw`
    INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptV1Uuid}::uuid, 'AWB1', 'DISPATCHED_BY_VENDOR', ${dispatchDate}, ${tnnt}::uuid, ${prog}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptV2Uuid}::uuid, 'AWB2', 'DISPATCHED_BY_VENDOR', ${dispatchDate}, ${tnnt}::uuid, ${prog}::uuid, now())
  `

  const unitV1Uuid = toUuid(newId('unit'))
  const unitV2Uuid = toUuid(newId('unit'))

  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, batch, status, device_serial, shipment, updated_at)
    VALUES (${unitV1Uuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${v1Uuid}::uuid, ${btchV1Uuid}::uuid, 'DISPATCHED', 'SN-V1', ${shptV1Uuid}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, batch, status, device_serial, shipment, updated_at)
    VALUES (${unitV2Uuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${v2Uuid}::uuid, ${btchV2Uuid}::uuid, 'DISPATCHED', 'SN-V2', ${shptV2Uuid}::uuid, now())
  `

  return { btchV1Wire: fromUuid('btch', btchV1Uuid), v1Wire, awb: 'AWB1' }
}

describe('readVendorHistory (spec 14b task 4)', () => {
  it('history lists own-vndr dispatched units with their AWB/status, PII-free', async () => {
    const { btchV1Wire, v1Wire, awb } = await seedHistory()

    const rows = await readVendorHistory(db, v1Wire)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ btchId: btchV1Wire, awb, shptStatus: 'DISPATCHED_BY_VENDOR' })
    expect(Object.keys(rows[0]!)).toEqual(['btchId', 'awb', 'shptStatus', 'dispatchDate', 'deviceSerial'])
  })
})
