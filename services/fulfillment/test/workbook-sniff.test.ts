import { describe, expect, it } from 'vitest'
import { sniffFulfillmentHeaders } from '../src/workbook-sniff.js'

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
