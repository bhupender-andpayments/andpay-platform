import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseReturnWorkbook } from '../src/return-sheet-adapter.js'

// D-4 / F8: the return WORKBOOK parser.
//
// The return route accepted JSON and nothing else while the real artifact is a
// spreadsheet, so BRD Phase 1 ("print vendor emails the Excel, AndPayments
// uploads it") could not work at all. Measured against the partner's real file
// the gap was threefold: format, column layout, and a missing AWB.

const HEADERS = ['Bank', 'Assignment', 'Merchant', 'Device ID', 'AWB', 'Courier']

async function xlsx(rows: string[][], headers: string[] = HEADERS): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Soundbox')
  ws.addRow(headers)
  for (const r of rows) ws.addRow(r)
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

function csv(rows: string[][], headers: string[] = HEADERS): Uint8Array {
  return new TextEncoder().encode([headers, ...rows].map((r) => r.join(',')).join('\n') + '\n')
}

const ROW = ['HDFC', 'asgn_1', 'Acme', '1234567890123', 'AWB-1', 'BLUEDART']

describe('parseReturnWorkbook (D-4 / F8)', () => {
  it('parses the vendor return sheet from xlsx', async () => {
    const r = await parseReturnWorkbook(await xlsx([ROW]), 'return.xlsx')
    expect(r.structuralErrors).toEqual([])
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toEqual([
      { deviceSerial: '1234567890123', asgnId: 'asgn_1', awb: 'AWB-1', courierCode: 'BLUEDART' },
    ])
  })

  it('parses the same sheet from csv', async () => {
    const r = await parseReturnWorkbook(csv([ROW]), 'return.csv')
    expect(r.validRows).toHaveLength(1)
  })

  it('treats Courier as OPTIONAL, omitting the key when blank', async () => {
    // ReturnRow.courierCode is optional and resolves to a vndr_ COURIER; an
    // empty cell must not become an empty-string courier that resolves to
    // nothing.
    const r = await parseReturnWorkbook(await xlsx([['HDFC', 'asgn_1', 'Acme', '1234567890123', 'AWB-1', '']]), 'r.xlsx')
    expect(r.validRows[0]).toEqual({ deviceSerial: '1234567890123', asgnId: 'asgn_1', awb: 'AWB-1' })
    expect('courierCode' in r.validRows[0]!).toBe(false)
  })

  it('REJECTS a legacy .xls by extension, naming the real fix', async () => {
    // The partner sends .xls today, so this is the first thing they would hit.
    const r = await parseReturnWorkbook(new Uint8Array([1, 2, 3]), 'Device id file from printer .xls')
    expect(r.structuralErrors[0]!.code).toBe('unsupported_extension')
    expect(r.structuralErrors[0]!.message).toMatch(/\.xlsx/)
  })

  it('reports a ZERO-WORKSHEET file as unreadable, NOT as empty', async () => {
    // THE SUBTLE ONE, verified against the partner's real .xls by hand: ExcelJS
    // does not throw on a BIFF8 file, it returns a workbook with ZERO
    // worksheets. Reporting that as "no rows" would send an operator hunting
    // for missing data in a file that is full of it.
    //
    // The fixture is a worksheet-less workbook rather than the real .xls on
    // purpose: that file lives in gitignored docs/ AND carries live merchant
    // PII, so a test depending on it would fail anywhere else and would put
    // real names in the repository. An empty workbook round-trips to zero
    // worksheets and exercises the identical branch.
    const wb = new ExcelJS.Workbook()
    const empty = new Uint8Array(await wb.xlsx.writeBuffer())
    const r = await parseReturnWorkbook(empty, 'renamed.xlsx')
    expect(r.structuralErrors[0]!.code).toBe('unreadable_file')
    expect(r.structuralErrors[0]!.message).toMatch(/legacy \.xls/)
    expect(r.structuralErrors[0]!.code).not.toBe('empty_sheet')
  })

  it('fails the WHOLE FILE on a missing required column, never row by row', async () => {
    // Every row would fail identically; 99 identical row errors would bury the
    // one fact the operator needs. Same policy as the bank and device-inventory
    // adapters.
    const r = await parseReturnWorkbook(
      await xlsx([['HDFC', 'asgn_1', 'Acme', '1234567890123']], ['Bank', 'Assignment', 'Merchant', 'Device ID']),
      'no-awb.xlsx',
    )
    expect(r.structuralErrors[0]!.code).toBe('missing_column')
    expect(r.structuralErrors[0]!.message).toMatch(/"AWB"/)
    expect(r.validRows).toEqual([])
  })

  it('names EVERY missing required column at once, not just the first', async () => {
    const r = await parseReturnWorkbook(await xlsx([['HDFC', 'Acme']], ['Bank', 'Merchant']), 'bare.xlsx')
    const msg = r.structuralErrors[0]!.message
    for (const col of ['Assignment', 'Device ID', 'AWB']) expect(msg).toContain(col)
  })

  it('quarantines a row missing a value, and still keeps the good rows', async () => {
    const r = await parseReturnWorkbook(
      await xlsx([ROW, ['HDFC', 'asgn_2', 'Acme', '1234567890124', '', '']]),
      'r.xlsx',
    )
    expect(r.validRows).toHaveLength(1)
    expect(r.invalidRows).toEqual([{ rowNo: 2, errors: ['missing_awb'] }])
  })

  it('reports every missing field on one row together', async () => {
    // Device ID is NOT among them any more: a blank device cell is a collateral
    // report, not a missing value. Assignment and AWB are still required,
    // because without them there is nothing to attach a consignment to.
    const r = await parseReturnWorkbook(await xlsx([['HDFC', '', 'Acme', '', '', '']]), 'r.xlsx')
    expect(r.invalidRows[0]!.errors).toEqual(['missing_assignment', 'missing_awb'])
  })

  // ONE DISPATCH ID, TWO AWBs (2026-08-10). The soundbox kit ships under one
  // AWB and the standee under another; the sheet has one AWB column per row, so
  // the second parcel is reported as its own row with the Device ID cell left
  // blank. The COLUMN stays required, only the VALUE became optional.
  it('accepts a blank Device ID as a COLLATERAL row, omitting the key rather than sending an empty string', async () => {
    const r = await parseReturnWorkbook(
      await xlsx([['HDFC', 'asgn_1', 'Acme', '', 'AWB-COLLATERAL', 'BLUEDART']]),
      'r.xlsx',
    )
    expect(r.structuralErrors).toEqual([])
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toHaveLength(1)
    // The KEY must be absent, not ''. ingestReturnSheet reads absent as
    // "collateral" and present-but-empty as schema-invalid, so an empty string
    // here would fail the whole file instead of reporting a parcel.
    expect('deviceSerial' in r.validRows[0]!).toBe(false)
    expect(r.validRows[0]).toEqual({ asgnId: 'asgn_1', awb: 'AWB-COLLATERAL', courierCode: 'BLUEDART' })
  })

  it('still fails the WHOLE file when the Device ID COLUMN is absent, not just its values', async () => {
    // The column and the value answer different questions. Getting the column
    // back proves the vendor returned OUR workbook; a blank cell inside it is a
    // deliberate report. Dropping the column requirement would read every row
    // of a device-less sheet as collateral.
    const r = await parseReturnWorkbook(
      await xlsx([['HDFC', 'asgn_1', 'Acme', 'AWB-1']], ['Bank', 'Assignment', 'Merchant', 'AWB']),
      'no-device-column.xlsx',
    )
    expect(r.structuralErrors[0]!.code).toBe('missing_column')
    expect(r.structuralErrors[0]!.message).toMatch(/"Device ID"/)
    expect(r.validRows).toEqual([])
  })

  it('keeps a collateral row and a device row side by side in one file', async () => {
    const r = await parseReturnWorkbook(
      await xlsx([ROW, ['HDFC', 'asgn_1', 'Acme', '', 'AWB-2', '']]),
      'r.xlsx',
    )
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toHaveLength(2)
    expect(r.validRows[0]!.deviceSerial).toBe('1234567890123')
    expect(r.validRows[1]!.deviceSerial).toBeUndefined()
    expect(r.validRows[1]!.awb).toBe('AWB-2')
  })

  it('matches headers case-insensitively, because a human retypes them', async () => {
    const r = await parseReturnWorkbook(
      await xlsx([ROW], ['bank', 'ASSIGNMENT', 'Merchant', 'device id', 'awb', 'courier']),
      'r.xlsx',
    )
    expect(r.structuralErrors).toEqual([])
    expect(r.validRows).toHaveLength(1)
  })

  it('accepts the column name WE SEND ("Assignment") and the one the portal expects ("Dispatch ID")', async () => {
    // A REAL ROUND-TRIP DEFECT this fixes. dispatchGroupXlsx sends the column
    // as "Dispatch ID" (the BRD's own term); "Assignment" survives as the
    // compatibility synonym. A vendor returning our sheet exactly as
    // instructed would have been rejected for a missing column.
    const ours = await parseReturnWorkbook(await xlsx([ROW]), 'r.xlsx')
    expect(ours.validRows[0]!.asgnId).toBe('asgn_1')

    const theirs = await parseReturnWorkbook(
      await xlsx([['HDFC', 'asgn_1', 'Acme', '1234567890123', 'AWB-1', 'BLUEDART']],
        ['Bank', 'Dispatch ID', 'Merchant', 'Device ID', 'AWB', 'Courier Partner']),
      'r.xlsx',
    )
    expect(theirs.structuralErrors).toEqual([])
    expect(theirs.validRows[0]).toEqual({
      deviceSerial: '1234567890123', asgnId: 'asgn_1', awb: 'AWB-1', courierCode: 'BLUEDART',
    })
  })

  it('names EVERY accepted spelling when a column is missing', async () => {
    // Tell the operator what WOULD work instead of leaving them to guess which
    // synonym we wanted.
    const r = await parseReturnWorkbook(await xlsx([['x']], ['Bank']), 'r.xlsx')
    const msg = r.structuralErrors[0]!.message
    expect(msg).toContain('"Assignment" or "Dispatch ID"')
  })

  it('imposes NO format rule on the values, matching the A-2 lock', async () => {
    // We have not measured a real returned AWB, and a rule invented for an
    // unseen value rejects real files. Presence is the bar until a real file
    // says otherwise.
    const r = await parseReturnWorkbook(await xlsx([['HDFC', 'asgn_x', 'Acme', 'ODD-SERIAL', 'ODD/AWB 9', '']]), 'r.xlsx')
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toHaveLength(1)
  })
})
