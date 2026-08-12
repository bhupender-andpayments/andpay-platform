import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { ingestReturnSheetOps } from '../src/return-sheet.js'

// The OPS-INITIATED return ingest (BRD FR-05 para 322: Phase 1 has the vendor
// EMAILING the filled sheet and the AndPayments team uploading it). What is
// specifically at stake here, beyond what return-sheet.test.ts already proves
// about the shared body, is the VENDOR RESOLUTION: the ops path derives the
// vendor from Batch.printVndr via the rows' Dispatch IDs, never from any input,
// and must refuse the whole file rather than guess when that derivation is
// ambiguous or empty.

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE unit, intake_exception, pending_pool_entry, shpt, vndr, outbox, inbox CASCADE')
})
afterAll(async () => {
  await db.$disconnect()
})

async function seedPrintVendor(name: string): Promise<string> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${vndrUuid}::uuid, 'PRINT', ${name}, 'ACTIVE', now())
  `
  return vndrUuid
}

async function seedUnit(deviceSerial: string): Promise<void> {
  const unitUuid = toUuid(newId('unit'))
  const manufacturerVndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${manufacturerVndrUuid}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}

/** A SENT_TO_VENDOR pool entry in a batch bound (or not) to a print vendor. */
async function seedDispatch(printVndrUuid: string | null): Promise<{ asgnWire: string }> {
  const asgnUuid = toUuid(newId('asgn'))
  const tenantUuid = toUuid(newId('tnnt'))
  const programUuid = toUuid(newId('prog'))
  const merchantUuid = toUuid(newId('mrch'))
  const batchUuid = toUuid(newId('btch'))
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, trigger_reason, unit_count, print_vndr, updated_at)
    VALUES (${batchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'MANUAL', 1,
            ${printVndrUuid}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id,
      created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${batchUuid}::uuid, 'SENT_TO_VENDOR',
      'file-1|1', ${newId('trace')}, now(), now()
    )
  `
  return { asgnWire: fromUuid('asgn', asgnUuid) }
}

describe('ingestReturnSheetOps', () => {
  it('resolves the vendor from Batch.printVndr and pairs the device under it', async () => {
    const printVndr = await seedPrintVendor('Demo Print Co')
    const { asgnWire } = await seedDispatch(printVndr)
    await seedUnit('869000000000001')

    const result = await ingestReturnSheetOps(db, {
      fileId: 'ops-file-1',
      rows: [{ deviceSerial: '869000000000001', asgnId: asgnWire, awb: 'AWB1001' }],
    })

    expect(result.rejected).toBeUndefined()
    // The identity the sheet was recorded under is the batch's own vendor.
    expect(result.vndrId).toBe(fromUuid('vndr', printVndr))
    expect(result.pairedUnitIds.length).toBe(1)
    expect(result.shptIds.length).toBe(1)
    expect(result.quarantined).toBe(0)

    // BRD para 332: the resulting status is Dispatched by Vendor, nothing else.
    const shpts = await db.$queryRaw<{ status: string; awb: string }[]>`SELECT status, awb FROM shpt`
    expect(shpts).toEqual([{ status: 'DISPATCHED_BY_VENDOR', awb: 'AWB1001' }])
  })

  it('dedups against the VENDOR path: same bytes, same {vendor}|{file} key, second ingest is a no-op', async () => {
    const printVndr = await seedPrintVendor('Demo Print Co')
    const { asgnWire } = await seedDispatch(printVndr)
    await seedUnit('869000000000002')
    const rows = [{ deviceSerial: '869000000000002', asgnId: asgnWire, awb: 'AWB1002' }]

    const first = await ingestReturnSheetOps(db, { fileId: 'shared-file', rows })
    expect(first.deduped).toBe(false)
    const second = await ingestReturnSheetOps(db, { fileId: 'shared-file', rows })
    expect(second.deduped).toBe(true)
    expect(second.pairedUnitIds.length).toBe(0)
  })

  it('REFUSES a sheet spanning batches bound to different print vendors', async () => {
    // Guessing which vendor to record would attribute half the file to the
    // wrong party; the operator is told to split the sheet instead.
    const a = await seedDispatch(await seedPrintVendor('Print A'))
    const b = await seedDispatch(await seedPrintVendor('Print B'))
    await seedUnit('869000000000003')
    await seedUnit('869000000000004')

    const result = await ingestReturnSheetOps(db, {
      fileId: 'ops-file-mixed',
      rows: [
        { deviceSerial: '869000000000003', asgnId: a.asgnWire, awb: 'AWB2001' },
        { deviceSerial: '869000000000004', asgnId: b.asgnWire, awb: 'AWB2002' },
      ],
    })
    expect(result.rejected).toBe('mixed_vendors')
    expect(result.pairedUnitIds.length).toBe(0)
    // Nothing was written: refusal happens before any transaction.
    const shpts = await db.$queryRaw<{ id: string }[]>`SELECT id FROM shpt`
    expect(shpts.length).toBe(0)
  })

  it('REFUSES when the covered batch has no print vendor recorded', async () => {
    const { asgnWire } = await seedDispatch(null)
    await seedUnit('869000000000005')
    const result = await ingestReturnSheetOps(db, {
      fileId: 'ops-file-unbound',
      rows: [{ deviceSerial: '869000000000005', asgnId: asgnWire, awb: 'AWB3001' }],
    })
    expect(result.rejected).toBe('batch_has_no_vendor')
    expect(result.pairedUnitIds.length).toBe(0)
  })

  it('REFUSES when no row names a batched dispatch', async () => {
    const result = await ingestReturnSheetOps(db, {
      fileId: 'ops-file-orphan',
      rows: [{ deviceSerial: '869000000000006', asgnId: newId('asgn'), awb: 'AWB4001' }],
    })
    expect(result.rejected).toBe('no_resolvable_dispatch')
  })

  it('still quarantines row-level problems exactly as the vendor path does', async () => {
    const printVndr = await seedPrintVendor('Demo Print Co')
    const { asgnWire } = await seedDispatch(printVndr)
    // NO unit seeded for this serial: device_not_in_inventory.
    const result = await ingestReturnSheetOps(db, {
      fileId: 'ops-file-quarantine',
      rows: [{ deviceSerial: '869999999999999', asgnId: asgnWire, awb: 'AWB5001' }],
    })
    expect(result.rejected).toBeUndefined()
    expect(result.quarantined).toBe(1)
    const exceptions = await db.$queryRaw<{ reason_code: string; vndr_id: string }[]>`
      SELECT reason_code, vndr_id::text AS vndr_id FROM intake_exception
    `
    expect(exceptions.length).toBe(1)
    expect(exceptions[0]!.reason_code).toBe('device_not_in_inventory')
    // Attributed to the RESOLVED vendor, so the queue reads the same as a
    // vendor-channel upload would.
    expect(exceptions[0]!.vndr_id).toBe(printVndr)
  })
})
