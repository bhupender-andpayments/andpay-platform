import { describe, it, expect } from 'vitest'
import { parseBankRequestFile, requestRowRejectReason } from '@andpay/tms-service'
import {
  buildSampleBankFile,
  SAMPLE_BANK_ROW_COUNT,
} from '../apps/ops-portal/src/features/uploads/sampleBankRequests.js'

// The sample bank file is a TESTING AID whose single promise is that it
// previews and commits cleanly EVERY time. This guard proves that promise the
// only way worth proving it: by running the REAL TMS parser and the REAL row
// validator over a generated file, rather than restating their rules in the
// portal and asserting the restatement.
//
// It lives in root test/ (the node project) for the same reason
// courier_status_parity.test.ts does: it is the one place allowed to see both
// sides. The portal cannot import a service (C4), so without this the
// generator's idea of a valid row and ingest.ts's idea of one drift silently,
// and the first anyone learns of it is a demo where the sample file quarantines.
//
// It is deliberately NOT a duplicate of the portal-side unit tests
// (apps/ops-portal/test/features/bank-sample-file.test.ts): those pin shape and
// uniqueness without a service dependency, this one pins the CONTRACT.

const FILE_ID = 'sample-parity'

async function parseGenerated(now?: Date, salt?: number) {
  const sample = now === undefined ? buildSampleBankFile() : buildSampleBankFile(now, salt)
  const parsed = await parseBankRequestFile(
    new TextEncoder().encode(sample.csv),
    sample.filename,
    FILE_ID,
  )
  return { sample, parsed }
}

describe('sample bank file passes the real TMS ingest contract', () => {
  it('is recognised as a bank file with no structural error', async () => {
    // Structural failure is whole-file: a missing signature column means the
    // Annexure B profile does not claim it, and a missing QR String column
    // rejects it outright. Either one is a dead demo.
    const { parsed } = await parseGenerated()
    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toHaveLength(SAMPLE_BANK_ROW_COUNT)
  })

  it('has zero rows rejected by requestRowRejectReason', async () => {
    // THE LOAD-BEARING ONE. This is the real validator, so it covers every rule
    // at once: qr/vpa format, the three non-blank name and address fields,
    // contact and 10 digit mobile, 3 to 4 digit category code, digits-only bank
    // and branch codes with branch mandatory, and non-negative collateral
    // counts. A failure here names the exact reason code the operator would see.
    const { parsed } = await parseGenerated()
    const rejections = parsed.rows
      .map((row) => ({ rowNo: row.rowNo, reason: requestRowRejectReason(row) }))
      .filter((r) => r.reason !== null)
    expect(rejections).toEqual([])
  })

  it('maps through the Annexure B profile, not the canonical fallback', async () => {
    // If the header ever drifts out of the profile's signature the file would
    // fall back to the canonical identity mapping and fail as a wall of
    // missing-canonical-field errors. The tenant constant is what proves the
    // profile actually claimed it: no column in the file carries it.
    const { parsed, sample } = await parseGenerated()
    for (const [i, row] of parsed.rows.entries()) {
      expect(row.tenantReference).toBe('GSCB')
      expect(row.productType).toBe('SOUNDBOX')
      // Merchant identity is VPA-derived today (the D1 interim), so this is
      // also the assertion that a fresh VPA yields a fresh merchant.
      expect(row.bankMerchantReference).toBe(`v1:vpa:${sample.vpas[i]!.toLowerCase()}`)
    }
  })

  it('marks every row as a soundbox request', async () => {
    // The Soundbox(Yes/No) column ships single letters and the profile
    // normalizes them. Getting this wrong is silent and expensive: it is the
    // bug that once dispatched 137 real merchants without the soundbox they
    // asked for, so it is asserted rather than assumed.
    const { parsed } = await parseGenerated()
    for (const row of parsed.rows) expect(row.soundbox).toBe(true)
  })

  it('shares no VPA between two downloads', async () => {
    // A soundbox row on a VPA already in the system is HELD with
    // duplicate_vpa_soundbox and lands in Queues instead of committing. That
    // gate is DB-backed, so what is provable here is its precondition: two
    // downloads never offer the same VPA.
    const first = await parseGenerated(new Date(1786000000000), 11)
    const second = await parseGenerated(new Date(1786000041000), 11)
    const firstVpas = new Set(first.parsed.rows.map((r) => r.vpaValue))
    expect(firstVpas.size).toBe(SAMPLE_BANK_ROW_COUNT)
    for (const row of second.parsed.rows) expect(firstVpas.has(row.vpaValue)).toBe(false)
  })

  it('carries a clean UPI payload, not the escaped-separator defect', async () => {
    // The real GSCB export HTML-escapes the first query separator, the defect
    // @andpay/bank-qr detects and corrects. A sample whose point is "nothing is
    // wrong with this file" must not also carry a bank-side bug, or the demo
    // shows a defect count nobody meant to show.
    const { parsed } = await parseGenerated()
    for (const row of parsed.rows) {
      expect(row.qrValue.startsWith('upi://pay?')).toBe(true)
      expect(row.qrValue).not.toContain('&amp;')
      expect(row.qrValue).toContain(`pa=${row.vpaValue}`)
    }
  })
})
