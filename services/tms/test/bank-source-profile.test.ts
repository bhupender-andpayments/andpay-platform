import { describe, it, expect } from 'vitest'
import { parseBankRequestFile } from '../src/bank-file-adapter.js'
import { selectBankSourceProfile, ANNEXURE_B_PROFILE, CANONICAL_PROFILE } from '../src/bank-source-profile.js'

// P3-3: the real GSCB layout (BRD Annexure B as the bank actually ships it).
// Header spellings and the sample row are copied VERBATIM from
// From Bank_GSCB_upi_Active_terminal_CWD_Data_from_14-May-2026_to_15-May-2026,
// including `Bank code` (lowercase c) and `Soundbox(Yes/No)` (no space), which
// differ from the BRD prose.
const ANNEXURE_B_HEADER =
  'Business Name,Contact Name,Mobile,Email ID,Category Code,Legal Name,Address,Address2,Address3,City,State,Pincode,Bank code,Branch code,QR Type,VPA,QR String,Soundbox(Yes/No),Standee Count,Sticker Count'

const ANNEXURE_B_ROW =
  'BRILLIANT PERFUME,BRILLIANT PERFUME,9537908017,,5977,BRILLIANT PERFUME,SHOP NO 31 3 NAVJYOTI CO OP H SOCIETY,LAXMI NARAYAN COLONY ROAD,OPP JIVAN VIHAR MANI NAGAR EAST,AHMEDABAD,Gujarat,380008,3,30,,w7dgo921gdqa@gscb,upi://pay?ver=01&amp;mode=01&pa=w7dgo921gdqa@gscb&pn=BRILLIANT PERFUME&mc=5977&qrMedium=06,N,1,2'

function csv(...lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

describe('selectBankSourceProfile', () => {
  it('claims a bank-native header for the Annexure B profile', () => {
    const header = ANNEXURE_B_HEADER.split(',')
    expect(selectBankSourceProfile(header)?.name).toBe(ANNEXURE_B_PROFILE.name)
  })

  it('claims a canonical header for the pass-through profile', () => {
    expect(selectBankSourceProfile(['bankMerchantReference', 'displayName', 'vpaValue'])?.name).toBe(
      CANONICAL_PROFILE.name,
    )
  })

  it('claims nothing for an unrecognised header, so the caller can still report missing columns', () => {
    expect(selectBankSourceProfile(['Some', 'Other', 'File'])).toBeNull()
  })
})

describe('parseBankRequestFile over the REAL Annexure B layout (P3-3)', () => {
  it('parses a bank-native file with no structural errors', async () => {
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'file-1')
    expect(res.errors).toEqual([])
    expect(res.rows).toHaveLength(1)
  })

  it('DERIVES the merchant reference from the VPA, versioned and lowercased (D1)', async () => {
    // The bank ships no merchant reference column and cannot add one, so the
    // VPA is the interim key. The v1: prefix makes the eventual re-key
    // identifiable instead of silent.
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'file-1')
    expect(res.rows[0]!.bankMerchantReference).toBe('v1:vpa:w7dgo921gdqa@gscb')
  })

  it('lowercases the derived key so one VPA cannot mint two merchants', async () => {
    const upper = ANNEXURE_B_ROW.replace('w7dgo921gdqa@gscb,upi', 'W7DGO921GDQA@GSCB,upi')
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, upper), 'gscb.csv', 'file-1')
    expect(res.rows[0]!.bankMerchantReference).toBe('v1:vpa:w7dgo921gdqa@gscb')
  })

  it('COMPOSES the address from the six separate columns, skipping the empty ones', async () => {
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'file-1')
    expect(res.rows[0]!.registeredAddress).toBe(
      'SHOP NO 31 3 NAVJYOTI CO OP H SOCIETY, LAXMI NARAYAN COLONY ROAD, OPP JIVAN VIHAR MANI NAGAR EAST, AHMEDABAD, Gujarat, 380008',
    )
    // The bank ships one address, so ship-to mirrors it until a file separates them.
    expect(res.rows[0]!.shipToAddress).toBe(res.rows[0]!.registeredAddress)
  })

  it('omits an empty address part rather than leaving a double separator', async () => {
    const noAddr2 = ANNEXURE_B_ROW.replace(',LAXMI NARAYAN COLONY ROAD,', ',,')
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, noAddr2), 'gscb.csv', 'file-1')
    expect(res.rows[0]!.registeredAddress).not.toContain(', ,')
  })

  it('maps the bank-native column spellings the file really uses', async () => {
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'file-1')
    const row = res.rows[0]!
    expect(row.displayName).toBe('BRILLIANT PERFUME')
    expect(row.mcc).toBe('5977')
    expect(row.bankReferenceCode).toBe('3')
    expect(row.branchCode).toBe('30')
    expect(row.mobile).toBe('9537908017')
    expect(row.vpaValue).toBe('w7dgo921gdqa@gscb')
    expect(row.standeeCount).toBe(1)
    expect(row.stickerCount).toBe(2)
  })

  it('reads Soundbox Y/N as a boolean (the file uses Y/N, the header says Yes/No)', async () => {
    const n = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'f')
    expect(n.rows[0]!.soundbox).toBe(false)
    const y = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW.replace(',N,1,2', ',Y,1,2')), 'gscb.csv', 'f')
    expect(y.rows[0]!.soundbox).toBe(true)
  })

  it('constants productType to SOUNDBOX, the only product today', async () => {
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'file-1')
    expect(res.rows[0]!.productType).toBe('SOUNDBOX')
  })

  it('carries the QR string VERBATIM, escaped separator included (D117/T2)', async () => {
    // TMS must never alter this value. The &amp; correction happens at the
    // artifact boundary in fulfillment (@andpay/bank-qr), not here.
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER, ANNEXURE_B_ROW), 'gscb.csv', 'file-1')
    expect(res.rows[0]!.qrValue).toContain('&amp;mode=01')
  })
})

describe('parseBankRequestFile backward compatibility', () => {
  it('still parses a canonical-header file unchanged', async () => {
    const header = 'bankMerchantReference,displayName,legalName,mcc,registeredAddress,bankReferenceCode,productType,vpaValue,qrValue,soundbox,standeeCount,stickerCount,shipToAddress,contactName,mobile,branchCode'
    const row = 'BM-1,Acme,Acme Pvt Ltd,5814,221B Baker St,HDFC,soundbox,acme@hdfcbank,upi://pay?pa=acme@hdfcbank,true,1,2,221B Baker St,Jane,9000000000,BR-1'
    const res = await parseBankRequestFile(csv(header, row), 'canonical.csv', 'file-1')
    expect(res.errors).toEqual([])
    expect(res.rows[0]!.bankMerchantReference).toBe('BM-1')
    expect(res.rows[0]!.productType).toBe('soundbox')
  })

  it('still reports missing columns for a file no profile claims', async () => {
    const res = await parseBankRequestFile(csv('Some,Other,File', 'a,b,c'), 'junk.csv', 'file-1')
    expect(res.rows).toEqual([])
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.errors.every((e) => e.code === 'missing_required_column')).toBe(true)
  })

  it('reports missing columns for an EMPTY file rather than looking like it lacks every column', async () => {
    // The required-column check runs against the profile's OUTPUT keys, which
    // are derived from the profile rather than from the data, so a header-only
    // bank file parses to zero rows with no structural error.
    const res = await parseBankRequestFile(csv(ANNEXURE_B_HEADER), 'empty.csv', 'file-1')
    expect(res.errors).toEqual([])
    expect(res.rows).toEqual([])
  })
})
