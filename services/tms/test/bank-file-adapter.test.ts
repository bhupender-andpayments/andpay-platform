import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  parseBankRequestFile,
  parseBankDamageFile,
  DEFAULT_REQUEST_COLUMN_MAPPING,
  DEFAULT_DAMAGE_COLUMN_MAPPING,
} from '../src/bank-file-adapter.js'

const REQUEST_HEADERS = Object.values(DEFAULT_REQUEST_COLUMN_MAPPING)
const DAMAGE_HEADERS = Object.values(DEFAULT_DAMAGE_COLUMN_MAPPING)

// One request row and one damage row, all fields as strings (matching how a
// CSV cell always arrives), so the xlsx fixture built below carries the
// SAME values and the two parse paths are directly comparable.
const REQUEST_DATA_ROW = [
  'BM-1',
  'Acme',
  'Acme Pvt Ltd',
  '5814',
  '221B Baker Street',
  'HDFC',
  'soundbox',
  'acme@hdfcbank',
  'upi://pay?pa=acme@hdfcbank',
  'true',
  '1',
  '2',
  '221B Baker Street',
  'Jane Doe',
  '+91-9000000000',
  'BR-001',
  'acme@hdfcbank',
]

// Aligned to DAMAGE_HEADERS: the trailing 4 (soundbox, standeeCount, stickerCount,
// deliveryStatus) are the OPTIONAL FR08-1/FR08-2 columns, left blank here so the
// canonical parse stays a 5-field clone row (populated variants tested below).
const DAMAGE_DATA_ROW = ['HDFC', 'acme@hdfcbank', 'physically damaged', 'unit cracked in transit', '221B Baker Street', '', '', '', '']

function toCsv(header: string[], rows: string[][]): Uint8Array {
  const lines = [header, ...rows].map((r) => r.map((f) => (f.includes(',') ? `"${f}"` : f)).join(','))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

async function toXlsx(header: string[], rows: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('sheet1')
  ws.addRow(header)
  for (const r of rows) ws.addRow(r)
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf)
}

describe('parseBankRequestFile (phase 2 task 1, D-C core)', () => {
  it('parses a .csv sample to the expected canonical BankRequestRow shape', async () => {
    const csv = toCsv(REQUEST_HEADERS, [REQUEST_DATA_ROW])
    const result = await parseBankRequestFile(csv, 'requests.csv', 'file-1')
    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([
      {
        fileId: 'file-1',
        rowNo: 1,
        bankMerchantReference: 'BM-1',
        displayName: 'Acme',
        legalName: 'Acme Pvt Ltd',
        mcc: '5814',
        registeredAddress: '221B Baker Street',
        bankReferenceCode: 'HDFC',
        productType: 'soundbox',
        vpaValue: 'acme@hdfcbank',
        qrValue: 'upi://pay?pa=acme@hdfcbank',
        soundbox: true,
        standeeCount: 1,
        stickerCount: 2,
        shipToAddress: '221B Baker Street',
        contactName: 'Jane Doe',
        mobile: '+91-9000000000',
        branchCode: 'BR-001',
        vpaHint: 'acme@hdfcbank',
      },
    ])
  })

  it('parses a .xlsx sample built with exceljs from the SAME data to an IDENTICAL canonical row', async () => {
    const csv = toCsv(REQUEST_HEADERS, [REQUEST_DATA_ROW])
    const xlsx = await toXlsx(REQUEST_HEADERS, [REQUEST_DATA_ROW])

    const csvResult = await parseBankRequestFile(csv, 'requests.csv', 'file-1')
    const xlsxResult = await parseBankRequestFile(xlsx, 'requests.xlsx', 'file-1')

    expect(xlsxResult.errors).toEqual([])
    expect(xlsxResult).toEqual(csvResult)
  })

  it('a row with an empty vpaHint omits the optional field, for both formats', async () => {
    const row = [...REQUEST_DATA_ROW]
    row[row.length - 1] = ''
    const csv = toCsv(REQUEST_HEADERS, [row])
    const xlsx = await toXlsx(REQUEST_HEADERS, [row])

    const csvResult = await parseBankRequestFile(csv, 'requests.csv', 'file-1')
    const xlsxResult = await parseBankRequestFile(xlsx, 'requests.xlsx', 'file-1')

    expect(csvResult.rows[0]).not.toHaveProperty('vpaHint')
    expect(xlsxResult).toEqual(csvResult)
  })

  it('returns a structural error, not a throw, for an unsupported extension', async () => {
    const csv = toCsv(REQUEST_HEADERS, [REQUEST_DATA_ROW])
    const result = await parseBankRequestFile(csv, 'requests.txt', 'file-1')
    expect(result.rows).toEqual([])
    expect(result.errors).toEqual([
      {
        code: 'unsupported_extension',
        message: 'Unsupported file extension for "requests.txt"; expected .csv or .xlsx.',
      },
    ])
  })

  it('returns a structural error, not a throw, for unreadable xlsx bytes', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const result = await parseBankRequestFile(garbage, 'requests.xlsx', 'file-1')
    expect(result.rows).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.code).toBe('unreadable_file')
  })

  it('returns a structural error, not a throw, for a missing required column', async () => {
    const headerMissingMcc = REQUEST_HEADERS.filter((h) => h !== 'mcc')
    const rowMissingMcc = REQUEST_DATA_ROW.filter((_v, idx) => REQUEST_HEADERS[idx] !== 'mcc')
    const csv = toCsv(headerMissingMcc, [rowMissingMcc])
    const result = await parseBankRequestFile(csv, 'requests.csv', 'file-1')
    expect(result.rows).toEqual([])
    expect(result.errors).toEqual([
      { code: 'missing_required_column', message: 'Missing required column "mcc" (field "mcc").' },
    ])
  })

  it('returns a structural error for a wholly empty file rather than throwing', async () => {
    const result = await parseBankRequestFile(new Uint8Array(), 'requests.csv', 'file-1')
    expect(result.rows).toEqual([])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.every((e) => e.code === 'missing_required_column')).toBe(true)
  })

  it('assigns sequential rowNo starting at 1 across multiple data rows', async () => {
    const second = [...REQUEST_DATA_ROW]
    second[0] = 'BM-2'
    const csv = toCsv(REQUEST_HEADERS, [REQUEST_DATA_ROW, second])
    const result = await parseBankRequestFile(csv, 'requests.csv', 'file-9')
    expect(result.rows.map((r) => [r.fileId, r.rowNo, r.bankMerchantReference])).toEqual([
      ['file-9', 1, 'BM-1'],
      ['file-9', 2, 'BM-2'],
    ])
  })
})

describe('parseBankDamageFile (phase 2 task 1, D-C core)', () => {
  it('parses a .csv sample to the expected canonical BankDamageRow shape', async () => {
    const csv = toCsv(DAMAGE_HEADERS, [DAMAGE_DATA_ROW])
    const result = await parseBankDamageFile(csv, 'damage.csv', 'file-2')
    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([
      {
        fileId: 'file-2',
        rowNo: 1,
        tenantReference: 'HDFC',
        vpaValue: 'acme@hdfcbank',
        damageReason: 'physically damaged',
        bankRemarks: 'unit cracked in transit',
        shipToAddress: '221B Baker Street',
      },
    ])
  })

  it('parses a .xlsx sample built with exceljs from the SAME data to an IDENTICAL canonical row', async () => {
    const csv = toCsv(DAMAGE_HEADERS, [DAMAGE_DATA_ROW])
    const xlsx = await toXlsx(DAMAGE_HEADERS, [DAMAGE_DATA_ROW])

    const csvResult = await parseBankDamageFile(csv, 'damage.csv', 'file-2')
    const xlsxResult = await parseBankDamageFile(xlsx, 'damage.xlsx', 'file-2')

    expect(xlsxResult.errors).toEqual([])
    expect(xlsxResult).toEqual(csvResult)
  })

  it('returns a structural error, not a throw, for a missing required column', async () => {
    const headerMissingReason = DAMAGE_HEADERS.filter((h) => h !== 'damageReason')
    const rowMissingReason = DAMAGE_DATA_ROW.filter((_v, idx) => DAMAGE_HEADERS[idx] !== 'damageReason')
    const csv = toCsv(headerMissingReason, [rowMissingReason])
    const result = await parseBankDamageFile(csv, 'damage.csv', 'file-2')
    expect(result.rows).toEqual([])
    expect(result.errors).toEqual([
      { code: 'missing_required_column', message: 'Missing required column "damageReason" (field "damageReason").' },
    ])
  })

  it('the FR08-1/FR08-2 columns are OPTIONAL: a file omitting them entirely still parses (no structural error)', async () => {
    const baseHeaders = ['tenantReference', 'vpaValue', 'damageReason', 'bankRemarks', 'shipToAddress']
    const csv = toCsv(baseHeaders, [['HDFC', 'acme@hdfcbank', 'physically damaged', 'r', 'Addr']])
    const result = await parseBankDamageFile(csv, 'damage.csv', 'file-2')
    expect(result.errors).toEqual([])
    expect(result.rows[0]).not.toHaveProperty('items')
    expect(result.rows[0]).not.toHaveProperty('deliveryStatus')
  })

  it('FR08-1: when the row supplies item columns, they are parsed as the item group (authoritative spec)', async () => {
    // positions 5..8 = soundbox, standeeCount, stickerCount, deliveryStatus
    const row = ['HDFC', 'acme@hdfcbank', 'physically damaged', 'r', 'Addr', 'false', '3', '0', 'In-Progress']
    const result = await parseBankDamageFile(toCsv(DAMAGE_HEADERS, [row]), 'damage.csv', 'file-2')
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({ items: { soundbox: false, standeeCount: 3, stickerCount: 0 }, deliveryStatus: 'In-Progress' })
  })

  it('FR08-1: item group is ALL-OR-NOTHING: one populated cell sets the whole group (blanks -> false/0)', async () => {
    const row = ['HDFC', 'acme@hdfcbank', 'physically damaged', 'r', 'Addr', '', '', '4', '']
    const result = await parseBankDamageFile(toCsv(DAMAGE_HEADERS, [row]), 'damage.csv', 'file-2')
    expect(result.rows[0]).toMatchObject({ items: { soundbox: false, standeeCount: 0, stickerCount: 4 } })
    expect(result.rows[0]).not.toHaveProperty('deliveryStatus')
  })
})
