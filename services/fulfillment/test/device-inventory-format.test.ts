import { describe, it, expect } from 'vitest'
import { parseDeviceInventoryFile } from '../src/device-inventory-adapter.js'

// A-2 / D12: the deliberately LOOSE per-row format check.
//
// Before it, the only row check was non-empty, so `Device ID = ABCDEF` was
// accepted and became a real unit. The bounds are wide on purpose and the
// reasoning is measured, not assumed (see the note above the patterns in
// device-inventory-adapter.ts):
//
//   - The CWD sample_150 file is MOCK data. Its ICCIDs fail the Luhn check that
//     real ICCIDs carry, and its 150 IMEIs carry 150 different TACs, which real
//     hardware of one model cannot. So its values cannot found a rule.
//   - The only REAL device ids we hold are 12 OR 13 digits, no fixed prefix, no
//     check digit.
//   - A rule read off the mock file would have been /^784\d{10}$/, which rejects
//     100% of the real file, or /^\d{13}$/, which rejects 6% of it.
//
// So these tests pin the BAND and the failure mode, deliberately NOT an exact
// length. Values here are representative shapes, never copied from the real
// merchant-linked file.

function csv(rows: Array<[string, string, string]>): Uint8Array {
  const body = rows.map(([qr, sim, id]) => `1,"${qr}",${sim},${id}`).join('\n')
  return new TextEncoder().encode(`Sl. No.,Device QR,Sim No,Device ID\n${body}\n`)
}

const QR = '{"DI":7846257907671,"DT":5,"MT":1}'
const SIM = '8991867825623397596U'

async function parseOne(qr: string, sim: string, id: string) {
  const r = await parseDeviceInventoryFile(csv([[qr, sim, id]]), 'cwd.csv')
  expect(r.structuralErrors).toEqual([])
  return r
}

describe('device inventory row format (A-2, deliberately loose)', () => {
  it('rejects the value that motivated this: a non-numeric device id', async () => {
    const r = await parseOne(QR, SIM, 'ABCDEF')
    expect(r.validRows).toHaveLength(0)
    expect(r.invalidRows).toEqual([{ rowNo: 1, errors: ['malformed_device_id'] }])
  })

  it('accepts BOTH real-world device id lengths, 12 and 13 digits', async () => {
    // The whole point of a band. 13 is the common case; 12 occurs in the real
    // printer file and an exact-13 rule would have quarantined those rows.
    for (const id of ['123456789012', '1234567890123']) {
      const r = await parseOne(QR, SIM, id)
      expect(r.invalidRows, `device id of length ${String(id.length)} must be accepted`).toEqual([])
      expect(r.validRows).toHaveLength(1)
    }
  })

  it('does not impose the mock file\'s prefix', async () => {
    // Real device ids start with anything from 1 to 9. A prefix rule taken from
    // the mock file (all 150 start 784) would reject every real row.
    for (const id of ['1846202138056', '9846202138056', '2846202138056']) {
      const r = await parseOne(QR, SIM, id)
      expect(r.invalidRows).toEqual([])
    }
  })

  it('keeps headroom on both sides of the observed lengths', async () => {
    // Tightening later is cheap; wrongly quarantining a real file is not. The
    // band is 10 to 20, so it fails only well outside anything plausible.
    const tooShort = await parseOne(QR, SIM, '123456789')
    expect(tooShort.invalidRows).toEqual([{ rowNo: 1, errors: ['malformed_device_id'] }])
    const wide = await parseOne(QR, SIM, '12345678901234567890')
    expect(wide.invalidRows).toEqual([])
  })

  it('accepts the sim no shape we have seen, digits plus a trailing letter', async () => {
    const r = await parseOne(QR, '8991867825623397596U', '1234567890123')
    expect(r.invalidRows).toEqual([])
  })

  it('rejects a sim no carrying punctuation, but nothing narrower', async () => {
    // Charset only. There is NO real-world evidence for sim no length (the real
    // file has no such column), so length stays a wide band.
    const r = await parseOne(QR, '8991-8678-2562', '1234567890123')
    expect(r.invalidRows).toEqual([{ rowNo: 1, errors: ['malformed_sim_no'] }])
  })

  it('leaves Device QR non-empty-only, because no real one has ever been seen', async () => {
    // Deliberately NOT validated as JSON or against a key set. The mock file is
    // the only source for that shape and it is untrustworthy at value level.
    const r = await parseOne('not json at all', SIM, '1234567890123')
    expect(r.invalidRows).toEqual([])
    expect(r.validRows).toHaveLength(1)
  })

  it('reports absent and malformed as DISTINCT codes, never both for one field', async () => {
    // Different corrections for the operator: a blank column is a mapping
    // problem, a malformed value suggests the wrong source file entirely.
    const blank = await parseOne(QR, SIM, '')
    expect(blank.invalidRows).toEqual([{ rowNo: 1, errors: ['missing_device_id'] }])
  })

  it('quarantines only the bad row and still ingests the good ones', async () => {
    // The property that makes a loose-then-tighten policy safe: a row we reject
    // must never cost the rest of the file.
    const r = await parseDeviceInventoryFile(
      csv([
        [QR, SIM, '1234567890123'],
        [QR, SIM, 'ABCDEF'],
        [QR, SIM, '123456789012'],
      ]),
      'cwd.csv',
    )
    expect(r.validRows).toHaveLength(2)
    expect(r.invalidRows).toEqual([{ rowNo: 2, errors: ['malformed_device_id'] }])
  })
})
