import { describe, it, expect } from 'vitest'
import { parseActivationFile } from '../src/activation-file-adapter.js'

// T5.5, D-19: the CWD's activation file. Pure parse, no database.
function csv(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join('\n'))
}

describe('parseActivationFile (T5.5, D-19)', () => {
  it('reads Device ID plus Status, case-insensitively on both the header and the token', async () => {
    const parsed = await parseActivationFile(csv(['device id,STATUS', 'SER-1,activated']), 'cwd.csv')
    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.validRows).toEqual([{ rowNo: 1, deviceId: 'SER-1' }])
  })

  it('accepts the several ways another company spells success', async () => {
    // The file is written by the CWD's ops team, and a difference of wording is
    // never a meaningful distinction here.
    const parsed = await parseActivationFile(
      csv([
        'Device ID,Status',
        'SER-1,Activated',
        'SER-2,Active',
        'SER-3,Success',
        'SER-4,Successful',
        'SER-5,Done',
      ]),
      'cwd.csv',
    )
    expect(parsed.validRows.map((r) => r.deviceId)).toEqual(['SER-1', 'SER-2', 'SER-3', 'SER-4', 'SER-5'])
  })

  it('REJECTS a row claiming a failure rather than skipping it (C3 fence)', async () => {
    // No failure write exists anywhere in the platform, so this row cannot be
    // honoured. Dropping it silently is how a device the CWD reported on ends up
    // with no recorded outcome and nobody notices.
    const parsed = await parseActivationFile(
      csv(['Device ID,Status', 'SER-1,Activated', 'SER-2,Failed']),
      'cwd.csv',
    )
    expect(parsed.validRows.map((r) => r.deviceId)).toEqual(['SER-1'])
    expect(parsed.invalidRows).toEqual([{ rowNo: 2, errors: ['unsupported_status'] }])
  })

  it('reports every failing check on a row at once', async () => {
    const parsed = await parseActivationFile(csv(['Device ID,Status', ',x']), 'cwd.csv')
    expect(parsed.invalidRows[0]!.errors).toEqual(['missing_device_id', 'unsupported_status'])
  })

  it('a missing required COLUMN fails the whole file, naming the column', async () => {
    const parsed = await parseActivationFile(csv(['Device ID', 'SER-1']), 'cwd.csv')
    expect(parsed.validRows).toEqual([])
    expect(parsed.structuralErrors).toHaveLength(1)
    expect(parsed.structuralErrors[0]!.column).toBe('Status')
  })

  it('a wholly blank file is a rejection, not an empty success', async () => {
    const parsed = await parseActivationFile(csv(['']), 'cwd.csv')
    expect(parsed.structuralErrors.length).toBeGreaterThan(0)
  })

  it('a correct header with no rows is a legitimate empty upload', async () => {
    const parsed = await parseActivationFile(csv(['Device ID,Status']), 'cwd.csv')
    expect(parsed.structuralErrors).toEqual([])
    expect(parsed.validRows).toEqual([])
  })

  it('refuses a file extension it cannot read', async () => {
    const parsed = await parseActivationFile(csv(['Device ID,Status']), 'cwd.pdf')
    expect(parsed.structuralErrors[0]!.code).toBe('unsupported_extension')
  })

  it('does NOT carry the status token forward: a valid row means exactly one thing', async () => {
    // Passing it downstream would invite a caller to branch on it and
    // reintroduce the failure path the C3 fence excludes.
    const parsed = await parseActivationFile(csv(['Device ID,Status', 'SER-1,Success']), 'cwd.csv')
    expect(Object.keys(parsed.validRows[0]!).sort()).toEqual(['deviceId', 'rowNo'])
  })
})
