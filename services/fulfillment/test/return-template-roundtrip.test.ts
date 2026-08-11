import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { dispatchGroupXlsx } from '../src/package.js'
import type { PackageLine } from '../src/package.js'
import { parseReturnWorkbook } from '../src/return-sheet-adapter.js'

// Task 7 (2026-08-11): the dispatch Excel becomes ITS OWN return template.
// dispatchGroupXlsx appends three blank vendor-fill columns whose headers are
// exactly the ones parseReturnWorkbook already accepts, so the file we send
// IS the file that comes back (W-5). The adapter also learns the
// untouched-row rule (a template row nobody filled is a skip, never an
// error) and a Shipment Number synonym for AWB.

function line(overrides: Partial<PackageLine> = {}): PackageLine {
  return {
    asgnId: 'asgn_1',
    dispatchGroup: null,
    bankReferenceCode: 'HDFC',
    branchCode: null,
    artifacts: [],
    labelDisplayName: 'Acme',
    labelQr: 'upi://pay?pa=test@bank',
    soundbox: true,
    standeeCount: 0,
    stickerCount: 0,
    merchantLegalName: 'Acme Pvt Ltd',
    ...overrides,
  }
}

async function loadHeaders(buf: Buffer): Promise<{ ws: ExcelJS.Worksheet; headers: string[]; col: (h: string) => number }> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.worksheets[0]!
  const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
  const col = (h: string): number => headers.indexOf(h) + 1
  return { ws, headers, col }
}

describe('dispatch Excel is its own return template (Task 7)', () => {
  it('dispatchGroupXlsx ends the header row with Device ID, AWB, Courier, empty in every data row', async () => {
    const lines = [line({ asgnId: 'asgn_1' }), line({ asgnId: 'asgn_2' })]
    const buf = await dispatchGroupXlsx(lines, 'SOUNDBOX')
    const { ws, headers, col } = await loadHeaders(buf)
    expect(headers.slice(-4)).toEqual(['Artifact Refs', 'Device ID', 'AWB', 'Courier'])
    for (let r = 2; r <= ws.rowCount; r++) {
      expect(ws.getRow(r).getCell(col('Device ID')).text).toBe('')
      expect(ws.getRow(r).getCell(col('AWB')).text).toBe('')
      expect(ws.getRow(r).getCell(col('Courier')).text).toBe('')
    }
  })

  it('the Collateral sheet carries the same three blank columns', async () => {
    const lines = [line({ asgnId: 'asgn_1', soundbox: false, standeeCount: 1 })]
    const buf = await dispatchGroupXlsx(lines, 'COLLATERAL')
    const { headers } = await loadHeaders(buf)
    expect(headers.slice(-4)).toEqual(['Artifact Refs', 'Device ID', 'AWB', 'Courier'])
  })

  it('accepts "Shipment Number" as an AWB synonym, case-insensitively', async () => {
    const csv = 'Dispatch ID,Device ID,shipment number\nasgn_1,SER-1,AWB-1\n'
    const r = await parseReturnWorkbook(new TextEncoder().encode(csv), 'return.csv')
    expect(r.structuralErrors).toEqual([])
    expect(r.validRows).toEqual([{ deviceSerial: 'SER-1', asgnId: 'asgn_1', awb: 'AWB-1' }])
  })

  it('untouched-row rule: Dispatch ID present, Device ID and AWB both blank -> untouchedRows, never an error', async () => {
    const csv = 'Dispatch ID,Device ID,AWB\nasgn_1,,\n'
    const r = await parseReturnWorkbook(new TextEncoder().encode(csv), 'r.csv')
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toEqual([])
    expect(r.untouchedRows).toBe(1)
  })

  it('half-filled: Device ID present, AWB blank -> still missing_awb', async () => {
    const csv = 'Dispatch ID,Device ID,AWB\nasgn_1,SER-1,\n'
    const r = await parseReturnWorkbook(new TextEncoder().encode(csv), 'r.csv')
    expect(r.invalidRows).toEqual([{ rowNo: 1, errors: ['missing_awb'] }])
    expect(r.validRows).toEqual([])
    expect(r.untouchedRows).toBe(0)
  })

  it('serial-less: AWB present, Device ID blank -> a valid row with no deviceSerial key', async () => {
    const csv = 'Dispatch ID,Device ID,AWB\nasgn_1,,AWB-1\n'
    const r = await parseReturnWorkbook(new TextEncoder().encode(csv), 'r.csv')
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toHaveLength(1)
    expect('deviceSerial' in r.validRows[0]!).toBe(false)
    expect(r.validRows[0]).toEqual({ asgnId: 'asgn_1', awb: 'AWB-1' })
    expect(r.untouchedRows).toBe(0)
  })

  it('a blank Dispatch ID keeps missing_assignment behavior regardless of the fill cells', async () => {
    // A fully blank csv line is dropped by the tokenizer before it ever
    // reaches row processing (a real, pre-existing rule, not this task's
    // concern), so this needs an xlsx sheet, whose grid reader keeps every
    // row up to rowCount regardless of blank cells.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Soundbox')
    ws.addRow(['Dispatch ID', 'Device ID', 'AWB'])
    ws.addRow(['', '', ''])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const r = await parseReturnWorkbook(new Uint8Array(buf), 'r.xlsx')
    expect(r.invalidRows).toEqual([{ rowNo: 1, errors: ['missing_assignment', 'missing_awb'] }])
    expect(r.untouchedRows).toBe(0)
  })

  it('a structural failure carries untouchedRows: 0', async () => {
    const r = await parseReturnWorkbook(new Uint8Array([1, 2, 3]), 'bad.xls')
    expect(r.structuralErrors.length).toBeGreaterThan(0)
    expect(r.untouchedRows).toBe(0)
  })

  it('round trip: the sheet we send IS the sheet that returns', async () => {
    const lines: PackageLine[] = [
      line({ asgnId: 'asgn_1', bankReferenceCode: 'A' }),
      line({ asgnId: 'asgn_2', bankReferenceCode: 'B' }),
      line({ asgnId: 'asgn_3', bankReferenceCode: 'C' }),
    ]
    const buf = await dispatchGroupXlsx(lines, 'SOUNDBOX')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
    const ws = wb.worksheets[0]!
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
    const col = (h: string): number => headers.indexOf(h) + 1

    // Sorted order is A, B, C (bank code order), so row 2 is asgn_1. Fill it,
    // as a vendor would with the returned template, leaving rows 3 and 4
    // exactly as sent.
    ws.getRow(2).getCell(col('Device ID')).value = 'SER-RT-1'
    ws.getRow(2).getCell(col('AWB')).value = 'AWB-RT-1'
    const filledBuf = Buffer.from(await wb.xlsx.writeBuffer())

    const r = await parseReturnWorkbook(new Uint8Array(filledBuf), 'return.xlsx')
    expect(r.structuralErrors).toEqual([])
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toHaveLength(1)
    expect(r.validRows[0]).toEqual({ deviceSerial: 'SER-RT-1', asgnId: 'asgn_1', awb: 'AWB-RT-1' })
    expect(r.untouchedRows).toBe(2)
  })
})
