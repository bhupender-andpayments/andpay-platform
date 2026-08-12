import { describe, it, expect } from 'vitest'
import { parseDeviceInventoryFile } from '../src/device-inventory-adapter.js'

// Workflow A (12 Aug 2026 walkthrough, FROZEN): the ONLY row validation is
// that Device ID is present. This file used to pin the A-2 format bands
// (device id and sim regexes, locked 2026-08-09); the walkthrough superseded
// that lock the other way, so these tests now pin the ABSENCE of every format
// rule, for the same reason the old lock test existed: a quiet "improvement"
// that starts rejecting a partner's real file must fail loudly here first.
//
// The duplicate check (the second half of the frozen rule) is not this
// file's subject: it lives in the shared ingest and is pinned by
// intake.test.ts and ops-device-inventory.test.ts.

function csv(rows: Array<[string, string, string]>): Uint8Array {
  // Real CSV quoting: inner quotes are doubled, so the QR JSON round-trips
  // byte for byte (these tests assert deviceQr content, which the previous
  // count-only tests never did).
  const body = rows.map(([qr, sim, id]) => `1,"${qr.replace(/"/g, '""')}",${sim},${id}`).join('\n')
  return new TextEncoder().encode(`Sl. No.,Device QR,Sim No,Device ID\n${body}\n`)
}

const QR = '{"DI":7846257907671,"DT":5,"MT":1}'
const SIM = '8991867825623397596U'

async function parseOne(qr: string, sim: string, id: string) {
  const r = await parseDeviceInventoryFile(csv([[qr, sim, id]]), 'cwd.csv')
  expect(r.structuralErrors).toEqual([])
  return r
}

describe('device inventory row validation (Workflow A frozen rule)', () => {
  it('THE FREEZE: values every earlier format rule rejected are all accepted now', async () => {
    // Each of these was a per-row reject under the superseded A-2 bands. The
    // walkthrough rules Device ID presence as the ONLY check, so all of them
    // must ingest. If one of these starts failing, someone re-added a format
    // rule without a ruling that supersedes 12 Aug 2026.
    const nowAccepted: Array<[string, string, string]> = [
      // non-numeric device id (the value that motivated the old bands)
      [QR, SIM, 'ABCDEF'],
      // shorter than the old 10-digit floor
      [QR, SIM, '123456789'],
      // longer than the old 20-digit ceiling
      [QR, SIM, '123456789012345678901'],
      // sim no carrying punctuation (old charset rule)
      [QR, '8991-8678-2562', '1234567890123'],
      // sim no shorter than the old 10-character floor
      [QR, '89910', '1234567890123'],
      // a QR that is not JSON (never validated, still not)
      ['plain-qr-value', SIM, '1234567890123'],
    ]
    for (const [qr, sim, id] of nowAccepted) {
      const r = await parseOne(qr, sim, id)
      expect(r.invalidRows, `must be accepted under the frozen rule: ${id} / ${sim} / ${qr.slice(0, 24)}`).toEqual([])
      expect(r.validRows).toHaveLength(1)
    }
  })

  it('a blank Sim No or Device QR CELL is a valid row carrying empty strings', async () => {
    const r = await parseOne(QR, '', '1234567890123')
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toEqual([{ rowNo: 1, deviceId: '1234567890123', simNo: '', deviceQr: QR }])

    const r2 = await parseOne('', '', '1234567890123')
    expect(r2.invalidRows).toEqual([])
    expect(r2.validRows).toEqual([{ rowNo: 1, deviceId: '1234567890123', simNo: '', deviceQr: '' }])
  })

  it('an entirely ABSENT Sim No / Device QR column is fine: rows pass through with empty strings', async () => {
    const bare = new TextEncoder().encode('Device ID\n1234567890123\nABCDEF\n')
    const r = await parseDeviceInventoryFile(bare, 'cwd.csv')
    expect(r.structuralErrors).toEqual([])
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toEqual([
      { rowNo: 1, deviceId: '1234567890123', simNo: '', deviceQr: '' },
      { rowNo: 2, deviceId: 'ABCDEF', simNo: '', deviceQr: '' },
    ])
  })

  it('the ONE row check: a blank Device ID is invalid, and it is the only error code', async () => {
    const blank = await parseOne(QR, SIM, '')
    expect(blank.validRows).toHaveLength(0)
    expect(blank.invalidRows).toEqual([{ rowNo: 1, errors: ['missing_device_id'] }])
  })

  it('a missing Device ID COLUMN is still a whole-file structural reject naming the column', async () => {
    // The frozen rule speaks to rows; a file with no Device ID column cannot
    // satisfy it for any row, so one structural error beats N row errors.
    const noIdColumn = new TextEncoder().encode('Sim No,Device QR\n8991867825623397596U,{"DI":1}\n')
    const r = await parseDeviceInventoryFile(noIdColumn, 'cwd.csv')
    expect(r.validRows).toHaveLength(0)
    expect(r.structuralErrors).toHaveLength(1)
    expect(r.structuralErrors[0]!.code).toBe('missing_required_column')
    expect(r.structuralErrors[0]!.column).toBe('Device ID')
  })

  it('skips only the blank-id row and still ingests the good ones', async () => {
    // The property that makes per-row rejection safe: a row we skip must
    // never cost the rest of the file.
    const r = await parseDeviceInventoryFile(
      csv([
        [QR, SIM, '1234567890123'],
        [QR, SIM, ''],
        [QR, SIM, 'ABCDEF'],
      ]),
      'cwd.csv',
    )
    expect(r.validRows).toHaveLength(2)
    expect(r.invalidRows).toEqual([{ rowNo: 2, errors: ['missing_device_id'] }])
  })
})
