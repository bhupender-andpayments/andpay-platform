import { describe, expect, it } from 'vitest'
import {
  buildSampleInventoryFile,
  SAMPLE_ROW_COUNT,
} from '../../src/features/inventory/sampleInventory.js'
import { DEVICE_INVENTORY_COLUMNS } from '../../src/features/uploads/uploadKinds.js'

// The sample-file generator is a TESTING AID, so the thing worth testing is the
// single property it exists for: a downloaded file ingests cleanly EVERY time,
// not just the first. Each assertion below is tied to a real rule in
// services/fulfillment (the adapter's structural and per-row checks, and
// intake.ts's duplicate gate), because a generator that drifts from those is
// worse than none: it hands a demo a file that quarantines.

function parse(csv: string): { header: string[]; rows: string[][] } {
  // Deliberately simple: the generator quotes only the Device QR cell, and this
  // splitter understands exactly that. A parser more clever than the writer
  // would hide a writer bug.
  const lines = csv.trimEnd().split('\n')
  const header = (lines[0] ?? '').split(',')
  const rows = lines.slice(1).map((line) => {
    const out: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else if (ch === '"') quoted = false
        else cell += ch
      } else if (ch === '"') quoted = true
      else if (ch === ',') {
        out.push(cell)
        cell = ''
      } else cell += ch
    }
    out.push(cell)
    return out
  })
  return { header, rows }
}

describe('inventory sample file (testing aid)', () => {
  it('carries the exact header the adapter expects, in sheet order', () => {
    // A missing Device ID COLUMN is a whole-file structural rejection, so this
    // is the assertion standing between the demo and a dead upload. Compared
    // against the shared constant, not a hand-typed copy, so a rename of the
    // contract breaks this test rather than the demo.
    const { header } = parse(buildSampleInventoryFile().csv)
    expect(header).toEqual([...DEVICE_INVENTORY_COLUMNS])
  })

  it('emits the expected row count with no blank Device ID', () => {
    // A blank Device ID is the ONLY per-row error the frozen Workflow A rule
    // keeps, and such a row is reported and skipped rather than ingested.
    const { rows } = parse(buildSampleInventoryFile().csv)
    expect(rows).toHaveLength(SAMPLE_ROW_COUNT)
    for (const row of rows) {
      expect(row[0]).toMatch(/^\d{13}$/)
      expect(row[0]?.trim()).not.toBe('')
    }
  })

  it('never repeats a Device ID or a Sim No inside one file', () => {
    // Within-file repeats flag duplicate_device_serial_in_file and
    // duplicate_sim_no_in_file, which is a quarantined row, not a pass.
    const { rows } = parse(buildSampleInventoryFile().csv)
    const deviceIds = rows.map((r) => r[0])
    const simNos = rows.map((r) => r[1])
    expect(new Set(deviceIds).size).toBe(SAMPLE_ROW_COUNT)
    expect(new Set(simNos).size).toBe(SAMPLE_ROW_COUNT)
  })

  it('shares no Device ID or Sim No between two downloads', () => {
    // THE LOAD-BEARING ONE: this is what "passes every single time" means. A
    // serial already on a unit flags duplicate_device_serial_existing_unit and
    // creates nothing, so two downloads overlapping by even one row would make
    // the second upload partially quarantine.
    const first = parse(buildSampleInventoryFile(new Date(1786000000000), 7).csv)
    const second = parse(buildSampleInventoryFile(new Date(1786000041000), 7).csv)
    const firstIds = new Set(first.rows.map((r) => r[0]))
    const firstSims = new Set(first.rows.map((r) => r[1]))
    for (const row of second.rows) {
      expect(firstIds.has(row[0])).toBe(false)
      expect(firstSims.has(row[1])).toBe(false)
    }
  })

  it('stays clear of the checked-in demo assets serial band', () => {
    // 4-devices-demo.csv uses 999000000xxxx. Those serials may already be on
    // units from an earlier demo run, so a generated file must not land in that
    // band. Positions 2 to 9 are a clock reading, which is what keeps it out.
    const { rows } = parse(buildSampleInventoryFile().csv)
    for (const row of rows) expect(row[0]?.startsWith('999000000')).toBe(false)
  })

  it('mirrors the Device ID into the Device QR blob, as the real sheet does', () => {
    // Carried as an opaque pass-through: the adapter never parses the serial
    // back out of it (the DI key spelling is unreliable in real files), but a
    // sample that disagreed with itself would mislead anyone reading it.
    const { rows } = parse(buildSampleInventoryFile().csv)
    for (const row of rows) {
      const qr = JSON.parse(row[2] ?? '{}') as { DI?: number }
      expect(String(qr.DI)).toBe(row[0])
    }
  })
})
