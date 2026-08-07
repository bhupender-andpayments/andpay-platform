import { describe, it, expect } from 'vitest'
import { requestRowRejectReason, type BankRequestRow } from '../src/ingest.js'

// P-A: the SOURCE-AGNOSTIC half of row validation. Before this, only emptiness
// was checked, and only on three columns, so a blank merchant name or a negative
// sticker count reached a print instruction unchallenged.
//
// The D3 per-column PATTERNS (Mobile exactly 10 digits, Category Code 3 or 4
// digits, Bank and Branch code numeric) are deliberately NOT tested here,
// because they are deliberately not IMPLEMENTED here. They were measured against
// one bank's file and belong with that bank's source profile, not in the
// validator every bank's file passes through. See the long note in
// services/tms/src/ingest.ts and the open ruling in
// docs/plan/BANK_FILE_DECISIONS_2026-08-07.md.
//
// These are pure-function tests on the ONE shared validator
// (services/tms/src/ingest.ts requestRowRejectReason), which both the ingest
// path and the preview surface call, so a rule proven here holds on both.
//
// Every field below is copied from a REAL row of
// From Bank_GSCB_upi_Active_terminal_CWD_Data_from_14-May-2026_to_15-May-2026.
// The QR keeps the bank's `&amp;` defect verbatim (D4: TMS stores what the bank
// sent; correction happens at the artifact boundary in fulfillment).
function validRow(overrides: Partial<BankRequestRow> = {}): BankRequestRow {
  return {
    fileId: 'gscb-file',
    rowNo: 1,
    bankMerchantReference: 'v1:vpa:w7dgo921gdqa@gscb',
    displayName: 'BRILLIANT PERFUME',
    legalName: 'BRILLIANT PERFUME',
    mcc: '5977',
    registeredAddress: 'SHOP NO 31 3 NAVJYOTI CO OP H SOCIETY, AHMEDABAD, Gujarat, 380008',
    bankReferenceCode: '3',
    productType: 'SOUNDBOX',
    vpaValue: 'w7dgo921gdqa@gscb',
    qrValue: 'upi://pay?ver=01&amp;mode=01&pa=w7dgo921gdqa@gscb&pn=BRILLIANT PERFUME&mc=5977&qrMedium=06',
    soundbox: false,
    standeeCount: 1,
    stickerCount: 2,
    shipToAddress: 'SHOP NO 31 3 NAVJYOTI CO OP H SOCIETY, AHMEDABAD, Gujarat, 380008',
    contactName: 'BRILLIANT PERFUME',
    mobile: '9537908017',
    branchCode: '30',
    ...overrides,
  }
}

describe('D3 row format validation: the baseline', () => {
  it('accepts a real GSCB row unchanged', () => {
    expect(requestRowRejectReason(validRow())).toBeNull()
  })
})

describe('Mobile and contact name: the D2 split into one code per column', () => {
  it('names the contact name column when it is empty', () => {
    expect(requestRowRejectReason(validRow({ contactName: '' }))).toBe('missing_contact_name')
  })

  it('names the mobile column when it is empty, not a shared contact code', () => {
    expect(requestRowRejectReason(validRow({ mobile: '' }))).toBe('missing_mobile')
  })

  it('accepts a +91 prefixed mobile, because the 10-digit rule is GSCB dialect and is NOT enforced here', () => {
    expect(requestRowRejectReason(validRow({ mobile: '+91-9000000000' }))).toBeNull()
  })
})

describe('D3 Standee and Sticker counts: non-negative integers', () => {
  it('accepts zero, which is a real quantity and not a missing value', () => {
    expect(requestRowRejectReason(validRow({ standeeCount: 0, stickerCount: 0 }))).toBeNull()
  })

  it('rejects a negative standee count', () => {
    expect(requestRowRejectReason(validRow({ standeeCount: -1 }))).toBe('invalid_standee_count')
  })

  it('rejects a fractional sticker count, since you cannot print half a sticker', () => {
    expect(requestRowRejectReason(validRow({ stickerCount: 1.5 }))).toBe('invalid_sticker_count')
  })

  it('rejects a NaN count, which is what a non-numeric cell parses to', () => {
    expect(requestRowRejectReason(validRow({ standeeCount: Number.NaN }))).toBe('invalid_standee_count')
  })
})

describe('D3 required text columns: zero empty in the 360 real rows', () => {
  it('rejects an empty business name', () => {
    expect(requestRowRejectReason(validRow({ displayName: '' }))).toBe('missing_display_name')
  })

  it('rejects an empty legal name', () => {
    expect(requestRowRejectReason(validRow({ legalName: '' }))).toBe('missing_legal_name')
  })

  it('rejects an empty registered address', () => {
    expect(requestRowRejectReason(validRow({ registeredAddress: '' }))).toBe('missing_registered_address')
  })

  it('rejects a whitespace-only name, which is empty to a human', () => {
    expect(requestRowRejectReason(validRow({ displayName: '   ' }))).toBe('missing_display_name')
  })
})
