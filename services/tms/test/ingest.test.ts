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
    contactName: 'Jane Doe', mobile: '+91-9000000000', branchCode: 'BR-001',
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

    const pend = await db.$queryRaw<{ correlation_id: string; qr_value: string; vpa_value: string; ship_to_address: string; contact_name: string | null; mobile: string | null; branch_code: string | null }[]>`SELECT correlation_id, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code FROM pending_row`
    expect(pend).toHaveLength(1)
    expect(pend[0]!.correlation_id).toBe('file-1|1')
    expect(pend[0]!.qr_value).toBe('upi://pay?pa=acme@hdfcbank')
    // 06a check 1: the recipient contact snapshot is parsed into pending_row.
    expect(pend[0]!.contact_name).toBe('Jane Doe')
    expect(pend[0]!.mobile).toBe('+91-9000000000')
    // Task 4: the Branch Code snapshot is parsed into pending_row.
    expect(pend[0]!.branch_code).toBe('BR-001')

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
    // 06a check 3: contact/mobile stay OFF the shared row fact (S7/S5, no drift).
    expect(fields).not.toContain('contactName')
    expect(fields).not.toContain('mobile')

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

  it('06a check 1: a row missing contact_name or mobile is rejected at ingest (FR-01b mandatory), quarantined with no row fact', async () => {
    const noContact = await ingestRequestRow(db, validRow({ rowNo: 3, contactName: '' }), 'trace-1')
    expect(noContact).toBe('quarantined')
    const q1 = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE row_no = 3`
    expect(q1).toHaveLength(1)
    expect(q1[0]!.reason_code).toBe('missing_contact_name')

    const noMobile = await ingestRequestRow(db, validRow({ rowNo: 4, mobile: '' }), 'trace-1')
    expect(noMobile).toBe('quarantined')
    const q2 = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE row_no = 4`
    expect(q2[0]!.reason_code).toBe('missing_mobile')

    // neither created a pending_row or a row fact (row-level rejection, S8).
    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row`
    expect(Number(pend[0]!.n)).toBe(0)
    const ob = await outboxRows()
    expect(ob).toHaveLength(0)
  })

  it('Task 4: a row missing branchCode is rejected at ingest (BRD 5.1b mandatory), quarantined with no row fact', async () => {
    const noBranch = await ingestRequestRow(db, validRow({ rowNo: 5, branchCode: '' }), 'trace-1')
    expect(noBranch).toBe('quarantined')
    const q = await db.$queryRaw<{ reason_code: string }[]>`SELECT reason_code FROM quarantine_row WHERE row_no = 5`
    expect(q).toHaveLength(1)
    expect(q[0]!.reason_code).toBe('missing_branch_code')

    // no pending_row or row fact for the rejected row (row-level rejection, S8).
    const pend = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pending_row`
    expect(Number(pend[0]!.n)).toBe(0)
    const ob = await outboxRows()
    expect(ob).toHaveLength(0)
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
