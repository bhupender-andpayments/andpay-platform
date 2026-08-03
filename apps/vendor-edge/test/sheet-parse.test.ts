import { describe, it, expect } from 'vitest'
import { parseIntakeSheet, parseReturnSheet, parseWebhookBody, EdgeParseError } from '../src/sheet-parse.js'

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
