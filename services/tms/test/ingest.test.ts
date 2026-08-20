import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'
import {
  ingestRequestRow,
  duplicateVpaVerdicts,
  type BankRequestRow,
  type DuplicateVpaOriginal,
} from '../src/ingest.js'
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
    mcc: '5814', registeredAddress: '221B Baker Street', bankReferenceCode: '3',
    productType: 'soundbox', vpaValue: 'acme@hdfcbank', qrValue: 'upi://pay?pa=acme@hdfcbank',
    soundbox: true, standeeCount: 1, stickerCount: 2, shipToAddress: '221B Baker Street',
    contactName: 'Jane Doe', mobile: '9000000000', branchCode: '30',
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
    expect(pend[0]!.mobile).toBe('9000000000')
    // Task 4: the Branch Code snapshot is parsed into pending_row.
    expect(pend[0]!.branch_code).toBe('30')

    const ob = await outboxRows()
    expect(ob).toHaveLength(1)
    expect(ob[0]!.event_type).toBe(ROW_FACT_TYPE)
    expect(ob[0]!.partition_key).toBe('3|BM-1')
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

// duplicateVpaVerdicts is the one piece of the soundbox duplicate-VPA gate
// (ruling 2026-08-10) that is PURE, and that purity is load-bearing: preview
// and commit both call it over the same seed, which is the only reason the two
// surfaces cannot disagree about which rows will be held. Tested here without a
// database, because none of it needs one.
describe('duplicateVpaVerdicts (ruling 2026-08-10): the pure file-order walk', () => {
  const ASSIGNMENT_ORIGINAL: DuplicateVpaOriginal = {
    kind: 'assignment',
    reference: 'asgn_seeded',
    merchantDisplayName: 'Acme',
  }
  const noSeed = new Map<string, DuplicateVpaOriginal>()

  it('never flags the FIRST occurrence: it is the row that does the seeding', () => {
    const verdicts = duplicateVpaVerdicts([validRow({ rowNo: 1, vpaValue: 'solo@gscb' })], noSeed)
    expect(verdicts.size).toBe(0)
  })

  it('flags the second and later soundbox rows, always naming the FIRST row as the original', () => {
    const verdicts = duplicateVpaVerdicts(
      [
        validRow({ rowNo: 1, vpaValue: 'again@gscb', displayName: 'Chai Point' }),
        validRow({ rowNo: 2, vpaValue: 'again@gscb' }),
        validRow({ rowNo: 3, vpaValue: 'again@gscb' }),
      ],
      noSeed,
    )
    expect([...verdicts.keys()]).toEqual([2, 3])
    // Row 3 points at row 1, NOT at row 2: the original is the first sighting,
    // and pointing at a row that was itself held would be a dead end.
    expect(verdicts.get(3)).toEqual({ kind: 'file_row', reference: '1', merchantDisplayName: 'Chai Point' })
  })

  it('the SEED wins over the file: a row matching a prior record names that record, not a file row', () => {
    const seed = new Map([['known@gscb', ASSIGNMENT_ORIGINAL]])
    const verdicts = duplicateVpaVerdicts(
      [validRow({ rowNo: 1, vpaValue: 'known@gscb' }), validRow({ rowNo: 2, vpaValue: 'known@gscb' })],
      seed,
    )
    // Even the FIRST row of the file is a duplicate here: the original is
    // already in the database.
    expect(verdicts.get(1)).toEqual(ASSIGNMENT_ORIGINAL)
    // And the seed is not overwritten by the file, so row 2 names it too rather
    // than pointing at row 1.
    expect(verdicts.get(2)).toEqual(ASSIGNMENT_ORIGINAL)
  })

  it('a soundbox=false row is never flagged, but STILL SEEDS the rows after it', () => {
    const verdicts = duplicateVpaVerdicts(
      [
        validRow({ rowNo: 1, vpaValue: 'seedme@gscb', soundbox: false, displayName: 'Tea Stall' }),
        validRow({ rowNo: 2, vpaValue: 'seedme@gscb', soundbox: false }),
        validRow({ rowNo: 3, vpaValue: 'seedme@gscb', soundbox: true }),
      ],
      noSeed,
    )
    // Rows 1 and 2 are collateral-only: D-2's flag-never-gate reading stands.
    expect([...verdicts.keys()]).toEqual([3])
    expect(verdicts.get(3)).toEqual({ kind: 'file_row', reference: '1', merchantDisplayName: 'Tea Stall' })
  })

  it('skips an empty VPA entirely: it can neither collide nor seed', () => {
    const verdicts = duplicateVpaVerdicts(
      [
        validRow({ rowNo: 1, vpaValue: '' }),
        validRow({ rowNo: 2, vpaValue: '   ' }),
        validRow({ rowNo: 3, vpaValue: '' }),
      ],
      noSeed,
    )
    // Two blank VPAs are not "the same merchant twice". Such rows are rejected
    // by requestRowRejectReason (invalid_qr_vpa_format) long before a verdict
    // would be consulted.
    expect(verdicts.size).toBe(0)
  })

  it('is case-insensitive: identity is v1:vpa:<lower(vpa)>, so one capital letter is not a new merchant', () => {
    const verdicts = duplicateVpaVerdicts(
      [validRow({ rowNo: 1, vpaValue: 'Case@GSCB' }), validRow({ rowNo: 2, vpaValue: ' case@gscb ' })],
      noSeed,
    )
    expect(verdicts.get(2)!.reference).toBe('1')
  })

  it('names no merchant when the earlier row has a blank display name, rather than showing an empty string', () => {
    const verdicts = duplicateVpaVerdicts(
      [validRow({ rowNo: 1, vpaValue: 'anon@gscb', displayName: '  ' }), validRow({ rowNo: 2, vpaValue: 'anon@gscb' })],
      noSeed,
    )
    expect(verdicts.get(2)!.merchantDisplayName).toBeNull()
  })
})
