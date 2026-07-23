import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import { ingestRequestRow, type BankRequestRow } from '../src/ingest.js'
import { ROW_FACT_TYPE } from '../src/row-fact.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => { await db.$disconnect() })

function validRow(over: Partial<BankRequestRow> = {}): BankRequestRow {
  return {
    fileId: 'file-1', rowNo: 1,
    bankMerchantReference: 'BM-1', displayName: 'Acme', legalName: 'Acme Pvt Ltd',
    mcc: '5814', registeredAddress: '221B Baker Street', bankReferenceCode: 'HDFC',
    productType: 'soundbox', vpaValue: 'acme@hdfcbank', qrValue: 'upi://pay?pa=acme@hdfcbank',
    soundbox: true, standeeCount: 1, stickerCount: 2, shipToAddress: '221B Baker Street',
    vpaHint: 'acme@hdfcbank', ...over,
  }
}

async function outboxRows() {
  return db.$queryRaw<{ event_type: string; partition_key: string; payload: unknown }[]>`
    SELECT event_type, partition_key, payload FROM outbox ORDER BY created_at
  `
}

describe('request-file ingest (spec 06 sections 6, 10; checks 3, 4)', () => {
  it('a valid row creates one pending_row and emits one row fact carrying only the identity slice (check 4)', async () => {
    const r = await ingestRequestRow(db, validRow(), 'trace-1')
    expect(r).toBe('accepted')

    const pend = await db.$queryRaw<{ correlation_id: string; qr_value: string; vpa_value: string; ship_to_address: string }[]>`SELECT correlation_id, qr_value, vpa_value, ship_to_address FROM pending_row`
    expect(pend).toHaveLength(1)
    expect(pend[0]!.correlation_id).toBe('file-1|1')
    expect(pend[0]!.qr_value).toBe('upi://pay?pa=acme@hdfcbank')

    const ob = await outboxRows()
    expect(ob).toHaveLength(1)
    expect(ob[0]!.event_type).toBe(ROW_FACT_TYPE)
    expect(ob[0]!.partition_key).toBe('HDFC|BM-1')
    // check 4: the row fact carries the identity slice + vpaHint, and NOT the
    // QR/VPA value, the demand slice, or the ship-to (S7/S5).
    const payload = ob[0]!.payload as { payload: Record<string, unknown> }
    const fields = Object.keys(payload.payload)
    expect(fields.sort()).toEqual(
      ['bankMerchantReference', 'bankReferenceCode', 'displayName', 'legalName', 'mcc', 'productType', 'registeredAddress', 'vpaHint'].sort(),
    )
    expect(fields).not.toContain('qrValue')
    expect(fields).not.toContain('vpaValue')
    expect(fields).not.toContain('shipToAddress')
    expect(fields).not.toContain('soundbox')

    const ing = await db.$queryRaw<{ row_total: number; row_accepted: number; row_rejected: number }[]>`SELECT row_total, row_accepted, row_rejected FROM ingest_file WHERE file_id = 'file-1'`
    expect(ing).toHaveLength(1)
    expect(ing[0]!.row_total).toBe(1)
    expect(ing[0]!.row_accepted).toBe(1)
  })

  it('re-ingesting the same file_id|row_no is a no-op: no second pending_row, no second row fact (check 3)', async () => {
    await ingestRequestRow(db, validRow(), 'trace-1')
    const again = await ingestRequestRow(db, validRow(), 'trace-1')
    expect(again).toBe('duplicate')
    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row`
    expect(Number(pend[0]!.n)).toBe(1)
    const ob = await outboxRows()
    expect(ob).toHaveLength(1)

    const ing = await db.$queryRaw<{ row_total: number; row_accepted: number; row_rejected: number }[]>`SELECT row_total, row_accepted, row_rejected FROM ingest_file WHERE file_id = 'file-1'`
    expect(ing).toHaveLength(1)
    expect(ing[0]!.row_total).toBe(1)
    expect(ing[0]!.row_accepted).toBe(1)
  })

  it('an invalid VPA/QR format is quarantined with no row fact (S8, D117 format-only)', async () => {
    const r = await ingestRequestRow(db, validRow({ rowNo: 2, vpaValue: 'not-a-vpa', qrValue: '' }), 'trace-1')
    expect(r).toBe('quarantined')
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row`
    expect(q).toHaveLength(1)
    const ob = await outboxRows()
    expect(ob).toHaveLength(0)

    const again = await ingestRequestRow(db, validRow({ rowNo: 2, vpaValue: 'not-a-vpa', qrValue: '' }), 'trace-1')
    expect(again).toBe('duplicate')
    const q2 = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row`
    expect(q2).toHaveLength(1)

    const ing = await db.$queryRaw<{ row_total: number; row_accepted: number; row_rejected: number }[]>`SELECT row_total, row_accepted, row_rejected FROM ingest_file WHERE file_id = 'file-1'`
    expect(ing).toHaveLength(1)
    expect(ing[0]!.row_total).toBe(1)
    expect(ing[0]!.row_rejected).toBe(1)
  })
})
