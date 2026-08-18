import { describe, expect, it } from 'vitest'
import { sniffFulfillmentHeaders, readWorkbookHeader } from '../src/workbook-sniff.js'

describe('sniffFulfillmentHeaders', () => {
  it('detects a return sheet by dispatch id plus awb', () => {
    expect(sniffFulfillmentHeaders(['Dispatch ID', 'Device ID', 'AWB', 'Courier'])).toEqual(['return-sheet'])
  })
  it('detects a courier file by status date', () => {
    expect(sniffFulfillmentHeaders(['AWB', 'Status', 'Status Date'])).toEqual(['courier-status'])
  })
  it('returns both candidates for the activation and unit-status collision', () => {
    expect(sniffFulfillmentHeaders(['Device ID', 'Status'])).toEqual(['activation', 'unit-status'])
  })
  it('detects device inventory', () => {
    expect(sniffFulfillmentHeaders(['Device ID', 'Sim No', 'Device QR'])).toEqual(['device-inventory'])
  })
  it('returns empty for an unknown header set', () => {
    expect(sniffFulfillmentHeaders(['foo', 'bar'])).toEqual([])
  })
})

// Fix round 1 (2026-08-18): readWorkbookHeader was xlsx-only, but every
// dedicated ingest adapter this sniffer routes to is CSV-capable, so a valid
// CSV drop on the smart-upload page must sniff exactly as its .xlsx twin
// would, not 400 as "unreadable".
describe('readWorkbookHeader', () => {
  it('reads the header row from a CSV, falling back off the failed xlsx load', async () => {
    const csv = Buffer.from('Dispatch ID,Device ID,AWB,Courier\ndsp_1,DEV1,AWB1,BLUEDART\n', 'utf8')
    const header = await readWorkbookHeader(csv)
    expect(header).toEqual(['Dispatch ID', 'Device ID', 'AWB', 'Courier'])
    // The CSV fallback is not just format plumbing: its header must sniff
    // exactly as the xlsx pure-test fixture above does.
    expect(sniffFulfillmentHeaders(header ?? [])).toEqual(['return-sheet'])
  })

  it('returns null for a plain-text file that is not a workbook and carries no header row', async () => {
    // Neither an xlsx (ExcelJS load fails on non-zip bytes) nor a CSV with any
    // non-blank row (blank lines only): there is no header here to sniff,
    // exactly as parseSheetGrid's own wholly-blank-file case has none.
    const garbage = Buffer.from('\n\n   \n\n', 'utf8')
    expect(await readWorkbookHeader(garbage)).toBeNull()
  })
})
