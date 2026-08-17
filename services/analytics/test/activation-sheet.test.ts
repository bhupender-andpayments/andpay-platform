import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { activationSheetXlsx } from '../src/export.js'
import type { ReportRow } from '../src/mediation.js'

// The activation sheet: the xlsx the CWD receives for a batch. Unlike toCsv,
// which is a generic serializer of whatever columns a report happens to carry,
// this is a PRODUCT-RULED sheet with a fixed seven-column contract and a fixed
// grain (one row per device, not one row per dispatch), so it gets its own
// test file rather than riding export.test.ts's generic CSV cases.
//
// A pure serializer test: no database, no scope, no watermark. The rows handed
// in are exactly the shape the ops-edge produces for the activation report
// (activationRow plus the edge's positionally-merged simNos).

// Resolve a header NAME to its column index rather than hardcoding a position,
// the same discipline as the fulfillment dispatch-package suite: a test that
// hardcoded column 5 would keep passing after someone reordered the sheet.
//
// That suite is named in prose rather than by its path, for the reason the C4
// guard comment in export.ts spells out: test/analytics_rail.test.ts scans this
// directory for a "services/<other context>/" substring and treats a comment
// citation exactly like an import, on purpose.
function headerIndex(ws: ExcelJS.Worksheet): (h: string) => number {
  const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
  return (h: string): number => headers.indexOf(h) + 1
}

async function sheetOf(rows: ReportRow[]): Promise<ExcelJS.Worksheet> {
  const buf = await activationSheetXlsx(rows)
  const wb = new ExcelJS.Workbook()
  // The duplicate-@types/node cast the tms bank-file-adapter documents at its
  // identical call site (exceljs's own dependency chain resolves a different,
  // older Buffer type than this file's Buffer; both are the real Node Buffer
  // class at runtime).
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.getWorksheet('Activation')
  expect(ws).toBeDefined()
  return ws!
}

// One activation worklist row as the ops-edge hands it over: activationRow's
// column set plus the edge-merged simNos.
function row(over: Partial<ReportRow> = {}): ReportRow {
  return {
    dispatchId: 'asgn_one',
    programId: '00000000-0000-0000-0000-000000000001',
    batchId: 'btch_one',
    bankCode: 'HDFC',
    bankDisplay: 'HDFC Bank',
    merchantDisplay: 'Acme Retail',
    deviceIds: ['DEV1'],
    simNos: ['SIM1'],
    deliveryDate: '2026-08-14T09:30:00.000Z',
    activationStatus: null,
    simActivationStatus: null,
    activationDate: null,
    activationFailureReason: null,
    ...over,
  }
}

describe('activationSheetXlsx', () => {
  it('returns a single worksheet named Activation', async () => {
    const buf = await activationSheetXlsx([row()])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0])
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Activation'])
  })

  it('returns a Buffer, never base64 and never a stream', async () => {
    const buf = await activationSheetXlsx([row()])
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  it('writes exactly the seven product-approved headers, in order', async () => {
    const ws = await sheetOf([row()])
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String)
    expect(headers).toEqual([
      'Batch ID',
      'Dispatch ID',
      'Bank',
      'Merchant',
      'Device ID',
      'SIM No',
      'Delivered',
    ])
  })

  // The grain the CWD actually activates is a device plus its SIM, so a
  // merchant with two soundboxes owes them two lines of work, not one line
  // holding two serials they have to split by hand.
  it('expands a two-device row into two data rows, repeating the Dispatch ID', async () => {
    const ws = await sheetOf([row({ deviceIds: ['DEV1', 'DEV2'], simNos: ['SIM1', 'SIM2'] })])
    const col = headerIndex(ws)
    expect(ws.rowCount).toBe(3)
    expect(String(ws.getRow(2).getCell(col('Dispatch ID')).value)).toBe('asgn_one')
    expect(String(ws.getRow(3).getCell(col('Dispatch ID')).value)).toBe('asgn_one')
    expect(String(ws.getRow(2).getCell(col('Device ID')).value)).toBe('DEV1')
    expect(String(ws.getRow(3).getCell(col('Device ID')).value)).toBe('DEV2')
    // Each device carries ITS OWN sim, read by the same index.
    expect(String(ws.getRow(2).getCell(col('SIM No')).value)).toBe('SIM1')
    expect(String(ws.getRow(3).getCell(col('SIM No')).value)).toBe('SIM2')
  })

  // The positional contract is the whole defect surface here: a shifted SIM
  // would send the CWD to activate the wrong subscriber against a device, and
  // nothing downstream could detect it.
  it('a SHORT simNos leaves the later SIM cells blank and shifts nothing', async () => {
    const ws = await sheetOf([row({ deviceIds: ['DEV1', 'DEV2', 'DEV3'], simNos: ['', 'SIM2'] })])
    const col = headerIndex(ws)
    expect(ws.rowCount).toBe(4)
    expect(String(ws.getRow(2).getCell(col('SIM No')).value ?? '')).toBe('')
    expect(String(ws.getRow(3).getCell(col('SIM No')).value)).toBe('SIM2')
    expect(String(ws.getRow(4).getCell(col('SIM No')).value ?? '')).toBe('')
    // The devices themselves are untouched by the short SIM list.
    expect(
      [2, 3, 4].map((r) => String(ws.getRow(r).getCell(col('Device ID')).value)),
    ).toEqual(['DEV1', 'DEV2', 'DEV3'])
  })

  it('a MISSING simNos leaves every SIM cell blank rather than throwing', async () => {
    const base = row({ deviceIds: ['DEV1', 'DEV2'] })
    delete base['simNos']
    const ws = await sheetOf([base])
    const col = headerIndex(ws)
    expect(ws.rowCount).toBe(3)
    expect(String(ws.getRow(2).getCell(col('SIM No')).value ?? '')).toBe('')
    expect(String(ws.getRow(3).getCell(col('SIM No')).value ?? '')).toBe('')
  })

  // Activation is of a physical device. A dispatch with no serial captured is
  // nothing the CWD could act on, so it must not occupy a line that reads as
  // actionable work.
  it('a row with an empty deviceIds contributes NO data rows', async () => {
    const ws = await sheetOf([row({ deviceIds: [] })])
    expect(ws.rowCount).toBe(1)
  })

  it('a row with a MISSING deviceIds contributes NO data rows', async () => {
    const base = row()
    delete base['deviceIds']
    const ws = await sheetOf([base])
    expect(ws.rowCount).toBe(1)
  })

  it('drops only the serial-less row and keeps its neighbours', async () => {
    const ws = await sheetOf([
      row({ dispatchId: 'asgn_a', deviceIds: ['DEVA'], simNos: ['SIMA'] }),
      row({ dispatchId: 'asgn_b', deviceIds: [], simNos: [] }),
      row({ dispatchId: 'asgn_c', deviceIds: ['DEVC'], simNos: ['SIMC'] }),
    ])
    const col = headerIndex(ws)
    expect(ws.rowCount).toBe(3)
    expect(
      [2, 3].map((r) => String(ws.getRow(r).getCell(col('Dispatch ID')).value)),
    ).toEqual(['asgn_a', 'asgn_c'])
  })

  // Wording approved by the product owner; an empty cell would read as a data
  // gap rather than as the real state of the dispatch.
  it('renders the literal "not yet delivered" when deliveryDate is null', async () => {
    const ws = await sheetOf([row({ deliveryDate: null })])
    const col = headerIndex(ws)
    expect(String(ws.getRow(2).getCell(col('Delivered')).value)).toBe('not yet delivered')
  })

  // The worklist screen deliberately stopped showing the wire timestamp; a
  // sheet emailed outside the platform must not put it back.
  it('renders a present deliveryDate as a plain YYYY-MM-DD calendar date, not the ISO timestamp', async () => {
    const ws = await sheetOf([row({ deliveryDate: '2026-08-14T09:30:00.000Z' })])
    const col = headerIndex(ws)
    const cell = String(ws.getRow(2).getCell(col('Delivered')).value)
    expect(cell).toBe('2026-08-14')
    expect(cell).not.toContain('T')
  })

  it('prefers bankDisplay and falls back to bankCode when it is absent or empty', async () => {
    const withDisplay = row({ dispatchId: 'asgn_a', bankDisplay: 'HDFC Bank', bankCode: 'HDFC' })
    const emptyDisplay = row({ dispatchId: 'asgn_b', bankDisplay: '', bankCode: 'ICICI' })
    const nullDisplay = row({ dispatchId: 'asgn_c', bankDisplay: null, bankCode: 'AXIS' })
    const ws = await sheetOf([withDisplay, emptyDisplay, nullDisplay])
    const col = headerIndex(ws)
    expect(
      [2, 3, 4].map((r) => String(ws.getRow(r).getCell(col('Bank')).value)),
    ).toEqual(['HDFC Bank', 'ICICI', 'AXIS'])
  })

  it('carries the Batch ID through and writes a null batchId as a blank cell', async () => {
    const ws = await sheetOf([
      row({ dispatchId: 'asgn_a', batchId: 'btch_abc' }),
      row({ dispatchId: 'asgn_b', batchId: null }),
    ])
    const col = headerIndex(ws)
    expect(String(ws.getRow(2).getCell(col('Batch ID')).value)).toBe('btch_abc')
    expect(String(ws.getRow(3).getCell(col('Batch ID')).value ?? '')).toBe('')
  })

  it('writes a missing merchantDisplay as a blank cell, never null', async () => {
    const base = row()
    delete base['merchantDisplay']
    const ws = await sheetOf([base])
    const col = headerIndex(ws)
    expect(String(ws.getRow(2).getCell(col('Merchant')).value ?? '')).toBe('')
  })

  // The caller decides whether an empty batch is a 404. The serializer's job is
  // to produce a valid file either way.
  it('an EMPTY input yields a header-only workbook, not an error', async () => {
    const ws = await sheetOf([])
    expect(ws.rowCount).toBe(1)
  })

  it('preserves the caller-supplied order and never re-sorts', async () => {
    const ws = await sheetOf([
      row({ dispatchId: 'asgn_z', deviceIds: ['DEVZ'], simNos: ['SIMZ'] }),
      row({ dispatchId: 'asgn_a', deviceIds: ['DEVA'], simNos: ['SIMA'] }),
      row({ dispatchId: 'asgn_m', deviceIds: ['DEVM'], simNos: ['SIMM'] }),
    ])
    const col = headerIndex(ws)
    expect(
      [2, 3, 4].map((r) => String(ws.getRow(r).getCell(col('Dispatch ID')).value)),
    ).toEqual(['asgn_z', 'asgn_a', 'asgn_m'])
  })
})
