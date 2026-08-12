import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { newId } from '@andpay/ids'
import { dispatchXlsx, type PackageLine } from '../src/package.js'
import { parseReturnWorkbook } from '../src/return-sheet-adapter.js'

// BRD FR-04 into FR-05: the sheet we HAND the print vendor must be the sheet we
// ACCEPT back, filled in. That is one requirement spanning two modules, and it was
// broken: `dispatchXlsx` shipped 13 columns with no `Device ID` and no `AWB`, while
// `parseReturnWorkbook` treats both as required and fails the whole file without
// them. `return-sheet-adapter.ts` even documented the round trip as working.
//
// So the vendor had to add two columns by hand, spelled exactly right, with nothing
// on the sheet telling them the names. Nobody would discover that until a file came
// back and was rejected wholesale.
//
// This test is deliberately a ROUND TRIP and not an assertion about a column list.
// A list assertion in either module can be satisfied while the pair still disagree,
// which is exactly the failure that happened. Generating a real workbook and parsing
// it back is the only check that cannot pass while the round trip is broken.
//
// No database: `dispatchXlsx` takes lines, so this stays a unit test.

function line(over: Partial<PackageLine> = {}): PackageLine {
  return {
    asgnId: newId('asgn'),
    bankReferenceCode: '1524',
    branchCode: '37',
    artifacts: [],
    labelDisplayName: 'MAYUR TRAVELS',
    labelQr: 'upi://pay?ver=01&mode=01&pa=qzlxbitad8zm@gscb',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    merchantLegalName: 'Mayur Travels Pvt Ltd',
    ...over,
  }
}

/**
 * Fill the two blank return columns on every data row of ONE sheet, as a vendor
 * would. Which sheet matters: the workbook has two.
 */
async function fillReturnColumns(
  xlsx: Buffer,
  values: (rowIndex: number) => { deviceId: string; awb: string; courier?: string },
  sheet = 'Standy',
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(xlsx as unknown as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.getWorksheet(sheet)!
  const header = ws.getRow(1)
  const colOf = (name: string): number => {
    for (let c = 1; c <= ws.columnCount; c += 1) {
      if ((header.getCell(c).text ?? '').trim() === name) return c
    }
    throw new Error(`the dispatch sheet has no "${name}" column`)
  }
  const device = colOf('Device ID')
  const awb = colOf('AWB')
  const courier = colOf('Courier Partner')
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const v = values(r)
    ws.getRow(r).getCell(device).value = v.deviceId
    ws.getRow(r).getCell(awb).value = v.awb
    if (v.courier !== undefined) ws.getRow(r).getCell(courier).value = v.courier
  }
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

describe('the dispatch sheet is the return sheet', () => {
  it('ships Device ID, AWB and Courier Partner as EMPTY columns for the vendor to fill', async () => {
    const xlsx = await dispatchXlsx([line()])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(xlsx as unknown as Parameters<typeof wb.xlsx.load>[0])
    const ws = wb.getWorksheet('Standy')!
    const headers: string[] = []
    for (let c = 1; c <= ws.columnCount; c += 1) headers.push(ws.getRow(1).getCell(c).text ?? '')

    expect(headers).toContain('Device ID')
    expect(headers).toContain('AWB')
    expect(headers).toContain('Courier Partner')
    // 'Dispatch ID' is the BRD FR-04 name. The parser accepts BOTH it and the
    // former 'Assignment' spelling, so workbooks downloaded before the rename
    // keep round-tripping.
    expect(headers).toContain('Dispatch ID')

    // Empty on the way out. A pre-filled value would be us inventing a device.
    const deviceCol = headers.indexOf('Device ID') + 1
    const awbCol = headers.indexOf('AWB') + 1
    expect(ws.getRow(2).getCell(deviceCol).text ?? '').toBe('')
    expect(ws.getRow(2).getCell(awbCol).text ?? '').toBe('')
  })

  it('parses back cleanly once the vendor fills those columns in', async () => {
    // standeeCount 1 and soundbox false, so each line lands on Standy ONLY. That
    // keeps this test about the columns and leaves the two-sheet case to its own
    // test below.
    const a = line({ bankReferenceCode: '1524', branchCode: '37', soundbox: false })
    const b = line({ bankReferenceCode: '18', branchCode: '4', soundbox: false })
    const xlsx = await dispatchXlsx([a, b])

    const filled = await fillReturnColumns(xlsx, (r) => ({
      deviceId: `DEV-${r}`,
      awb: `AWB-${r}`,
      courier: 'BLUEDART',
    }))

    const parsed = await parseReturnWorkbook(filled, 'returned.xlsx')

    // The whole point: no missing_column, nothing rejected.
    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.invalidRows).toEqual([])
    expect(parsed.validRows).toHaveLength(2)

    // The Assignment column round-tripped as the assignment id, so pairing has
    // something real to resolve against.
    expect(parsed.validRows.map((r) => r.asgnId).sort()).toEqual([a.asgnId, b.asgnId].sort())
    expect(parsed.validRows.map((r) => r.deviceSerial).sort()).toEqual(['DEV-2', 'DEV-3'])
    expect(parsed.validRows.every((r) => r.courierCode === 'BLUEDART')).toBe(true)
  })

  // The defect this test was written to catch, and it did. `readXlsxGrid` read
  // `worksheets[0]` only, which is `Soundbox`. Our workbook puts the bulk of the
  // work on `Standy` (340 rows against 116 in the sample file), so a vendor filling
  // Standy had every row DISCARDED: not quarantined, never read.
  it('reads the Standy sheet, not only the first sheet', async () => {
    const standeeOnly = line({ soundbox: false, standeeCount: 1 })
    const xlsx = await dispatchXlsx([standeeOnly])

    const filled = await fillReturnColumns(xlsx, () => ({ deviceId: 'DEV-STANDY', awb: 'AWB-1' }), 'Standy')
    const parsed = await parseReturnWorkbook(filled, 'returned.xlsx')

    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.validRows.map((r) => r.deviceSerial)).toEqual(['DEV-STANDY'])
  })

  it('takes both sheets when a merchant appears on each, and pairs are left to the ingester', async () => {
    // soundbox AND a standee, so this one line is written to BOTH sheets, which is
    // correct: it is on each sheet because of what must be printed for it.
    const both = line({ soundbox: true, standeeCount: 1 })
    const xlsx = await dispatchXlsx([both])

    let filled = await fillReturnColumns(xlsx, () => ({ deviceId: 'DEV-1', awb: 'AWB-1' }), 'Soundbox')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(filled as unknown as Parameters<typeof wb.xlsx.load>[0])
    filled = await fillReturnColumns(
      Buffer.from(await wb.xlsx.writeBuffer()),
      () => ({ deviceId: 'DEV-1', awb: 'AWB-1' }),
      'Standy',
    )

    const parsed = await parseReturnWorkbook(filled, 'returned.xlsx')
    expect(parsed.structuralErrors).toEqual([])
    // Both rows come through. Deduplicating them is NOT this parser's job: pairing
    // is idempotent per unit and a second attempt on the same device quarantines as
    // `unit_already_paired`, so swallowing a row here would hide a real signal.
    expect(parsed.validRows).toHaveLength(2)
    expect(parsed.validRows.every((r) => r.asgnId === both.asgnId)).toBe(true)
  })

  it('still rejects a row whose Device ID was never filled', async () => {
    // Guards against the opposite mistake: shipping the columns must not make the
    // parser lenient about their CONTENTS.
    const xlsx = await dispatchXlsx([line({ soundbox: false })])
    const parsed = await parseReturnWorkbook(new Uint8Array(xlsx), 'returned.xlsx')
    expect(parsed.validRows).toEqual([])
    expect(parsed.invalidRows).toHaveLength(1)
    expect(parsed.invalidRows[0]!.errors).toContain('missing_device_id')
    expect(parsed.invalidRows[0]!.errors).toContain('missing_awb')
  })
})
