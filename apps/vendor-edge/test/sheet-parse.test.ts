import { describe, it, expect } from 'vitest'
import {
  parseIntakeSheet,
  parseReturnSheet,
  parseReturnSheetPartial,
  parseWebhookBody,
  EdgeParseError,
} from '../src/sheet-parse.js'

// Unit coverage for the S8 edge schema gate (apps/vendor-edge/src/sheet-parse.ts):
// the strict allow-listed shape checks, and the m1 defense-in-depth control-byte
// rejection (a raw 0x1e/0x1f can never enter an id/label field, hence never the
// resourceIds carried into an authz-audit record). Every rejection throws
// EdgeParseError, mapped to HTTP 400 by the calling controller.

const baseIntake = (): Record<string, unknown> => ({
  fileId: 'file-1',
  vndrId: 'vndr_1',
  workQueue: 'wq-1',
  rows: [] as unknown[],
})

const baseReturn = (): Record<string, unknown> => ({
  fileId: 'file-1',
  vndrId: 'vndr_1',
  workQueue: 'wq-1',
  rows: [] as unknown[],
})

describe('parseIntakeSheet', () => {
  it('rejects a non-object body', () => {
    expect(() => parseIntakeSheet('not an object')).toThrow(EdgeParseError)
    expect(() => parseIntakeSheet(null)).toThrow(EdgeParseError)
    expect(() => parseIntakeSheet([1, 2])).toThrow(EdgeParseError)
  })

  it('rejects an extra top-level field (assertOnlyKeys)', () => {
    expect(() => parseIntakeSheet({ ...baseIntake(), extraField: 'nope' })).toThrow(EdgeParseError)
  })

  it('rejects a missing required top-level field', () => {
    const { fileId: _fileId, ...rest } = baseIntake()
    expect(() => parseIntakeSheet(rest)).toThrow(EdgeParseError)
  })

  it('rejects an empty string field', () => {
    expect(() => parseIntakeSheet({ ...baseIntake(), vndrId: '' })).toThrow(EdgeParseError)
  })

  it('rejects a control-character string field (m1 defense-in-depth)', () => {
    expect(() => parseIntakeSheet({ ...baseIntake(), vndrId: 'vndr_\x1e1' })).toThrow(EdgeParseError)
  })

  it('rejects non-array rows', () => {
    expect(() => parseIntakeSheet({ ...baseIntake(), rows: 'not-an-array' })).toThrow(EdgeParseError)
  })

  it('rejects an unknown row kind', () => {
    expect(() => parseIntakeSheet({ ...baseIntake(), rows: [{ kind: 'BOGUS' }] })).toThrow(EdgeParseError)
  })

  it('rejects a non-positive QUANTITY_LINE count', () => {
    expect(() =>
      parseIntakeSheet({
        ...baseIntake(),
        rows: [{ kind: 'QUANTITY_LINE', productType: 'SOUNDBOX', qrString: 'qr-1', count: 0 }],
      }),
    ).toThrow(EdgeParseError)
    expect(() =>
      parseIntakeSheet({
        ...baseIntake(),
        rows: [{ kind: 'QUANTITY_LINE', productType: 'SOUNDBOX', qrString: 'qr-1', count: -1 }],
      }),
    ).toThrow(EdgeParseError)
  })

  it('accepts a well-formed sheet', () => {
    const sheet = parseIntakeSheet({
      ...baseIntake(),
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-1', productType: 'SOUNDBOX', deviceQr: { di: 'DI-1' } }],
    })
    expect(sheet.rows).toHaveLength(1)
  })

  // Fast-follow (SIM No capture): the SERIALIZED shape admits an OPTIONAL simNo
  // (an ICCID). Only SIM-bearing devices carry it, so a serialized row WITHOUT
  // simNo stays valid; when present it is validated like any id/label field
  // (non-empty, no control byte, m1).
  it('accepts a SERIALIZED row carrying an optional simNo (ICCID)', () => {
    const sheet = parseIntakeSheet({
      ...baseIntake(),
      rows: [
        {
          kind: 'SERIALIZED',
          deviceSerial: 'SER-1',
          productType: 'SOUNDBOX',
          deviceQr: { di: 'DI-1' },
          simNo: '8991922406975395100U',
        },
      ],
    })
    const row = sheet.rows[0]!
    expect(row.kind).toBe('SERIALIZED')
    if (row.kind === 'SERIALIZED') expect(row.simNo).toBe('8991922406975395100U')
  })

  it('accepts a SERIALIZED row WITHOUT simNo (optional, non-SIM devices)', () => {
    const sheet = parseIntakeSheet({
      ...baseIntake(),
      rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-1', productType: 'STANDEE', deviceQr: { di: 'DI-1' } }],
    })
    const row = sheet.rows[0]!
    expect(row.kind).toBe('SERIALIZED')
    if (row.kind === 'SERIALIZED') expect(row.simNo).toBeUndefined()
  })

  it('rejects an empty-string simNo', () => {
    expect(() =>
      parseIntakeSheet({
        ...baseIntake(),
        rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-1', productType: 'SOUNDBOX', deviceQr: { di: 'DI-1' }, simNo: '' }],
      }),
    ).toThrow(EdgeParseError)
  })

  it('rejects a non-string simNo', () => {
    expect(() =>
      parseIntakeSheet({
        ...baseIntake(),
        rows: [{ kind: 'SERIALIZED', deviceSerial: 'SER-1', productType: 'SOUNDBOX', deviceQr: { di: 'DI-1' }, simNo: 42 }],
      }),
    ).toThrow(EdgeParseError)
  })

  it('rejects a control-character simNo (m1 defense-in-depth)', () => {
    expect(() =>
      parseIntakeSheet({
        ...baseIntake(),
        rows: [
          { kind: 'SERIALIZED', deviceSerial: 'SER-1', productType: 'SOUNDBOX', deviceQr: { di: 'DI-1' }, simNo: '8991\x1e22' },
        ],
      }),
    ).toThrow(EdgeParseError)
  })
})

describe('parseReturnSheet', () => {
  it('rejects a non-object body', () => {
    expect(() => parseReturnSheet(42)).toThrow(EdgeParseError)
  })

  it('rejects an extra row field (assertOnlyKeys)', () => {
    expect(() =>
      parseReturnSheet({ ...baseReturn(), rows: [{ deviceSerial: 'd1', asgnId: 'a1', awb: 'awb1', extraField: 'x' }] }),
    ).toThrow(EdgeParseError)
  })

  it('rejects a missing required row field', () => {
    expect(() => parseReturnSheet({ ...baseReturn(), rows: [{ deviceSerial: 'd1', awb: 'awb1' }] })).toThrow(
      EdgeParseError,
    )
  })

  it('rejects a control-character string in a row field (m1 defense-in-depth)', () => {
    expect(() =>
      parseReturnSheet({ ...baseReturn(), rows: [{ deviceSerial: 'd\x1e1', asgnId: 'a1', awb: 'awb1' }] }),
    ).toThrow(EdgeParseError)
  })

  it('rejects non-array rows', () => {
    expect(() => parseReturnSheet({ ...baseReturn(), rows: {} })).toThrow(EdgeParseError)
  })

  // deviceSerial became OPTIONAL (2026-08-10): a row with a dispatch id and an
  // AWB but no serial reports a COLLATERAL-only consignment, because one
  // dispatch id can travel under two AWBs. It is handled exactly like
  // courierCode: absent is allowed, present must be a non-empty
  // control-char-free string. This edge checks SHAPE only; what an absent
  // serial MEANS is the domain's business.
  it('accepts a row with NO deviceSerial (the collateral row) and omits the key', () => {
    const parsed = parseReturnSheet({ ...baseReturn(), rows: [{ asgnId: 'a1', awb: 'awb1' }] })
    expect(parsed.rows).toHaveLength(1)
    expect('deviceSerial' in parsed.rows[0]!).toBe(false)
    expect(parsed.rows[0]!.asgnId).toBe('a1')
    expect(parsed.rows[0]!.awb).toBe('awb1')
  })

  it('still rejects a PRESENT but empty deviceSerial (absent is a meaning, "" is a bug)', () => {
    expect(() =>
      parseReturnSheet({ ...baseReturn(), rows: [{ deviceSerial: '', asgnId: 'a1', awb: 'awb1' }] }),
    ).toThrow(EdgeParseError)
  })

  it('still rejects a control character in a PRESENT deviceSerial (m1 survives the optionality)', () => {
    expect(() =>
      parseReturnSheet({ ...baseReturn(), rows: [{ deviceSerial: 'd\x1e1', asgnId: 'a1', awb: 'awb1' }] }),
    ).toThrow(EdgeParseError)
  })

  it('still rejects a collateral row missing asgnId or awb', () => {
    expect(() => parseReturnSheet({ ...baseReturn(), rows: [{ awb: 'awb1' }] })).toThrow(EdgeParseError)
    expect(() => parseReturnSheet({ ...baseReturn(), rows: [{ asgnId: 'a1' }] })).toThrow(EdgeParseError)
  })

  it('keeps courierCode working on a collateral row', () => {
    const parsed = parseReturnSheet({
      ...baseReturn(),
      rows: [{ asgnId: 'a1', awb: 'awb1', courierCode: 'BLUEDART' }],
    })
    expect(parsed.rows[0]).toEqual({ asgnId: 'a1', awb: 'awb1', courierCode: 'BLUEDART' })
  })
})

// D-14 (12 Aug 2026): matching is record-by-record, never file-by-file. The
// workbook path always reported a bad row as invalidRows and ingested the rest;
// the JSON path threw on the FIRST bad row, so one malformed row cost every
// correct row in the same upload. parseReturnSheetPartial is that fix, and it
// keeps the ENVELOPE strict, because an unreadable envelope names no rows at all.
describe('parseReturnSheetPartial (D-14 per-row rejection on the JSON path)', () => {
  it('keeps the good rows and reports only the bad one', () => {
    const { sheet, invalidRows } = parseReturnSheetPartial({
      ...baseReturn(),
      rows: [
        { deviceSerial: 'd1', asgnId: 'a1', awb: 'awb1' },
        { deviceSerial: 'd2', awb: 'awb2' }, // no asgnId
        { deviceSerial: 'd3', asgnId: 'a3', awb: 'awb3' },
      ],
    })
    expect(sheet.rows).toHaveLength(2)
    expect(sheet.rows.map((r) => r.asgnId)).toEqual(['a1', 'a3'])
    // rowNo is 1-based over the data rows, the SAME convention the workbook
    // adapter uses, so the field means one thing on both paths.
    expect(invalidRows).toEqual([{ rowNo: 2, errors: ['missing_assignment'] }])
  })

  it('classifies a missing awb, and a shape violation that is neither missing field', () => {
    const { sheet, invalidRows } = parseReturnSheetPartial({
      ...baseReturn(),
      rows: [
        { deviceSerial: 'd1', asgnId: 'a1' }, // no awb
        { deviceSerial: 'd2', asgnId: 'a2', awb: 'awb2', extraField: 'x' }, // unknown key
        { deviceSerial: '', asgnId: 'a3', awb: 'awb3' }, // present-but-empty serial
        { deviceSerial: 'd\x1e4', asgnId: 'a4', awb: 'awb4' }, // control character
        'not-an-object',
      ],
    })
    expect(sheet.rows).toHaveLength(0)
    expect(invalidRows).toEqual([
      { rowNo: 1, errors: ['missing_awb'] },
      { rowNo: 2, errors: ['invalid_row_shape'] },
      { rowNo: 3, errors: ['invalid_row_shape'] },
      { rowNo: 4, errors: ['invalid_row_shape'] },
      { rowNo: 5, errors: ['invalid_row_shape'] },
    ])
  })

  it('still rejects the ENVELOPE whole-file: a bad envelope names no row to keep', () => {
    // These are the workbook path's structuralErrors by another name, and they
    // must stay fatal: there is nothing to partially ingest.
    expect(() => parseReturnSheetPartial(42)).toThrow(EdgeParseError)
    expect(() => parseReturnSheetPartial({ ...baseReturn(), rows: {} })).toThrow(EdgeParseError)
    expect(() => parseReturnSheetPartial({ ...baseReturn(), extraTop: 'x' })).toThrow(EdgeParseError)
    const { fileId: _fileId, ...noFileId } = baseReturn()
    expect(() => parseReturnSheetPartial({ ...noFileId, rows: [] })).toThrow(EdgeParseError)
  })

  it('a file whose every row is bad is an EMPTY sheet, not a throw', () => {
    // The ingest then has nothing to do and the vendor gets its row report,
    // which is a truer answer than a 400 that says the file was unreadable.
    const { sheet, invalidRows } = parseReturnSheetPartial({
      ...baseReturn(),
      rows: [{ awb: 'awb1' }, { asgnId: 'a2' }],
    })
    expect(sheet.rows).toEqual([])
    expect(invalidRows).toHaveLength(2)
  })

  it('accepts a wholly valid file with no invalidRows, unchanged from the strict parse', () => {
    const body = { ...baseReturn(), rows: [{ asgnId: 'a1', awb: 'awb1', courierCode: 'BLUEDART' }] }
    const { sheet, invalidRows } = parseReturnSheetPartial(body)
    expect(invalidRows).toEqual([])
    expect(sheet).toEqual(parseReturnSheet(body))
  })
})

describe('parseWebhookBody', () => {
  it('rejects a non-object body', () => {
    expect(() => parseWebhookBody('nope')).toThrow(EdgeParseError)
    expect(() => parseWebhookBody(null)).toThrow(EdgeParseError)
    expect(() => parseWebhookBody([1])).toThrow(EdgeParseError)
    expect(() => parseWebhookBody(42)).toThrow(EdgeParseError)
  })

  it('accepts a plain object, passed through unchanged', () => {
    expect(parseWebhookBody({ a: 1 })).toEqual({ a: 1 })
  })
})
