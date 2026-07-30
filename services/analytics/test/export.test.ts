import { describe, it, expect } from 'vitest'
import { toCsv, MAX_CSV_BYTES } from '../src/export.js'
import type { ReportRow } from '../src/mediation.js'

// Task 6: inline CSV export of a mediated ReportRow[] result. RFC 4180
// quoting; no S3, no port; bounded to the same 5 MiB-class discipline as the
// existing edges (the presigned-S3 transport is a deferred follow-up).

describe('toCsv', () => {
  it('returns an empty string for an empty result set', () => {
    expect(toCsv([])).toBe('')
  })

  it('serializes a header row plus one line per row, in first-seen column order', () => {
    const rows: ReportRow[] = [
      { dispatchId: 'disp_1', bankCode: 'HDFC', awb: 'AWB1' },
      { dispatchId: 'disp_2', bankCode: 'ICICI', awb: null },
    ]
    const csv = toCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('dispatchId,bankCode,awb')
    expect(lines[1]).toBe('disp_1,HDFC,AWB1')
    expect(lines[2]).toBe('disp_2,ICICI,')
  })

  it('quotes fields containing a comma, a double-quote, or a newline; doubles embedded quotes (RFC 4180)', () => {
    const rows: ReportRow[] = [
      { merchantDisplay: 'Acme, Inc.', damageReason: 'Said "cracked"', branch: 'Line1\nLine2' },
    ]
    const csv = toCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[1]).toBe('"Acme, Inc.","Said ""cracked""","Line1\nLine2"')
  })

  it('renders booleans, numbers, null, and string[] cells', () => {
    const rows: ReportRow[] = [
      { isReplacement: true, poolSize: 3, activationStatus: null, deviceIds: ['DEV1', 'DEV2'] },
    ]
    const csv = toCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[1]).toBe('true,3,,DEV1;DEV2')
  })

  it('round-trips a realistic report result (every declared column reappears, values preserved)', () => {
    const rows: ReportRow[] = [
      { dispatchId: 'disp_1', programId: 'prog_1', bankCode: 'HDFC', awb: 'AWB1', dispatchDate: '2026-07-20T00:00:00.000Z', courierStatus: 'DELIVERED_OK', deliveryDate: null },
      { dispatchId: 'disp_2', programId: 'prog_1', bankCode: 'ICICI', awb: null, dispatchDate: null, courierStatus: null, deliveryDate: null },
    ]
    const csv = toCsv(rows)
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(3) // header + 2 rows
    const header = lines[0]!.split(',')
    expect(header).toEqual(['dispatchId', 'programId', 'bankCode', 'awb', 'dispatchDate', 'courierStatus', 'deliveryDate'])
    expect(lines[1]).toContain('disp_1')
    expect(lines[1]).toContain('AWB1')
    expect(lines[2]).toContain('disp_2')
  })

  it('throws (bounded, no silent truncation) when the serialized CSV exceeds the 5 MiB-class discipline', () => {
    // One ~200-byte row repeated enough times to exceed MAX_CSV_BYTES.
    const bigCell = 'x'.repeat(150)
    const row: ReportRow = { col: bigCell }
    const rowCount = Math.ceil(MAX_CSV_BYTES / 150) + 100
    const rows: ReportRow[] = Array.from({ length: rowCount }, () => row)
    expect(() => toCsv(rows)).toThrow(/5 MiB/)
  })
})
