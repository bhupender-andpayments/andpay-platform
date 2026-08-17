import { describe, expect, it } from 'vitest'
import {
  buildSampleBankFile,
  SAMPLE_BANK_ROW_COUNT,
} from '../../src/features/uploads/sampleBankRequests.js'

// Portal-side shape guard for the sample bank file. The CONTRACT (that every
// row survives the real TMS parser and validator) is proven in
// test/bank_sample_file_parity.test.ts, which is the only place allowed to see
// both sides. This file covers what does not need a service dependency: the
// header the profile signature matches on, and the per-download uniqueness that
// makes the file repeatable.

function header(csv: string): string[] {
  return (csv.split('\n')[0] ?? '').split(',')
}

describe('sample bank file (testing aid)', () => {
  it('carries the four signature columns the Annexure B profile matches on', () => {
    // ANNEXURE_B_PROFILE claims a file only when ALL of these are present. Miss
    // one and the file falls back to the canonical mapping and fails as a wall
    // of missing-field errors naming columns the bank never had.
    const cols = header(buildSampleBankFile().csv)
    for (const required of ['Business Name', 'VPA', 'Bank code', 'Mobile']) {
      expect(cols).toContain(required)
    }
  })

  it('carries QR String, whose absence rejects the whole file', () => {
    // A requiredSourceColumn, deliberately outside the signature: the file is
    // still recognised without it and rejected whole, naming this one column.
    expect(header(buildSampleBankFile().csv)).toContain('QR String')
  })

  it('emits the expected row count with distinct VPAs', () => {
    const sample = buildSampleBankFile()
    expect(sample.vpas).toHaveLength(SAMPLE_BANK_ROW_COUNT)
    expect(new Set(sample.vpas).size).toBe(SAMPLE_BANK_ROW_COUNT)
    expect(sample.csv.trimEnd().split('\n')).toHaveLength(SAMPLE_BANK_ROW_COUNT + 1)
  })

  it('never repeats a VPA across two downloads', () => {
    const first = buildSampleBankFile(new Date(1786000000000), 4)
    const second = buildSampleBankFile(new Date(1786000041000), 4)
    for (const vpa of second.vpas) expect(first.vpas).not.toContain(vpa)
  })

  it('names the file distinctly per download', () => {
    // Two files sitting in a downloads folder under one name is how the wrong
    // one gets picked mid-demo.
    const a = buildSampleBankFile(new Date(1786000000000), 4)
    const b = buildSampleBankFile(new Date(1786000041000), 4)
    expect(a.filename).not.toBe(b.filename)
    expect(a.filename.endsWith('.csv')).toBe(true)
  })
})
