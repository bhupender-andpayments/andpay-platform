// P3-3: bank-file SOURCE PROFILES.
//
// THE PROBLEM. The bank-file adapter's column mapping is 1:1 (one source header
// per canonical field), which is enough to RENAME a column but not enough for
// the file a bank actually ships. The first real GSCB file
// (From Bank_GSCB_upi_Active_terminal_CWD_Data, 360 rows, verified 2026-08-07)
// needs three things a rename cannot express:
//
//   1. COMPOSITION. There is no `registeredAddress` column. The address is
//      spread across Address / Address2 / Address3 / City / State / Pincode.
//   2. DERIVATION. There is no merchant reference column AT ALL, and the bank
//      cannot add one. Bhupender ruled (D1, 2026-08-07) that the merchant key
//      is the VPA for now, so the reference is DERIVED here as
//      `v1:vpa:<lowercased vpa>`. The `v1:` prefix exists so the eventual
//      re-key is identifiable rather than silent.
//   3. CONSTANTS. There is no `productType` column; soundbox dispatch is the
//      only product today.
//
// THE SHAPE. A profile turns ONE raw record (keyed by the file's own headers)
// into a record keyed by CANONICAL field names. Everything downstream then runs
// unchanged against the existing identity mapping: same required-field check,
// same normalizeRequestRow, same row validation. A profile is pure and does no
// I/O, so it stays as testable as the adapter it feeds.
//
// SELECTION is by header signature, not by configuration. D5 left open whether
// a per-bank mapping is per-file or per-row, and the real file settles half of
// it: ONE file carries 19 distinct Bank codes (member banks under the GSCB
// tenant), so a mapping can NEVER be resolved per bank code. It is a property
// of the FILE's layout. Until a second bank ships a different layout, matching
// on the layout itself is honest and needs no config plumbing through the edge.
//
// NOT DONE HERE: per-column FORMAT validation (lengths, patterns). A profile
// only reshapes. Row validation stays where it already lives, in ingest.ts.

/** A raw record keyed by the source file's own header names. */
export type SourceRecord = Record<string, string>

export interface BankSourceProfile {
  /** Stable identifier, surfaced in tests and diagnostics. Never user input. */
  readonly name: string
  /**
   * Headers that must ALL be present for this profile to claim a file. This is
   * the signature match, deliberately narrow enough that two profiles cannot
   * both claim the same file.
   */
  readonly signature: readonly string[]
  /** Reshape one raw record into canonical-field-keyed form. */
  toCanonical(rec: SourceRecord): SourceRecord
}

// The bank partner every Annexure B file belongs to. One partner today; a
// second would need its own profile (or the tenant to come from the upload
// context, which is the more general answer once there are several).
export const ANNEXURE_B_TENANT_REFERENCE = 'GSCB'

function joinNonEmpty(parts: readonly string[], separator = ', '): string {
  return parts.map((p) => p.trim()).filter((p) => p !== '').join(separator)
}

// The BRD Annexure B layout, as the bank actually ships it. Header spellings
// are taken from the real file, NOT from the BRD prose, which differs: the file
// has `Bank code` (lowercase c) and `Soundbox(Yes/No)` (no space), and splits
// Address into three separate columns rather than the one row Annexure B shows.
export const ANNEXURE_B_PROFILE: BankSourceProfile = {
  name: 'annexure-b',
  signature: ['Business Name', 'VPA', 'Bank code', 'Mobile'],
  toCanonical(rec: SourceRecord): SourceRecord {
    const vpa = (rec['VPA'] ?? '').trim()
    const address = joinNonEmpty([
      rec['Address'] ?? '',
      rec['Address2'] ?? '',
      rec['Address3'] ?? '',
      rec['City'] ?? '',
      rec['State'] ?? '',
      rec['Pincode'] ?? '',
    ])
    return {
      // D1: merchant identity is the VPA for now. Lowercased so a casing
      // difference between two files cannot mint a second merchant for one VPA.
      bankMerchantReference: vpa === '' ? '' : `v1:vpa:${vpa.toLowerCase()}`,
      displayName: rec['Business Name'] ?? '',
      legalName: rec['Legal Name'] ?? '',
      mcc: rec['Category Code'] ?? '',
      registeredAddress: address,
      // The row's Bank code is the AGGREGATOR (member bank / branch). The
      // TENANT is the bank partner whose file this is, which appears nowhere in
      // the file: a GSCB export carries 19 aggregator codes and no GSCB
      // identifier. It is therefore a property of the layout, declared here, so
      // one file yields one tenant, one program and one pool.
      bankReferenceCode: rec['Bank code'] ?? '',
      tenantReference: ANNEXURE_B_TENANT_REFERENCE,
      // Soundbox dispatch is the only product today. When a second product
      // arrives this becomes a real column and this constant goes away.
      productType: 'SOUNDBOX',
      vpaValue: vpa,
      // Shipped VERBATIM, escaped separators and all: D117/T2 forbids TMS
      // altering it, and the correction happens at the artifact boundary in
      // fulfillment (services/fulfillment/src/qr-payload.ts).
      qrValue: rec['QR String'] ?? '',
      // The header SAYS Yes/No but the file ships single letters Y/N, and the
      // adapter's shared parseBoolean only accepts true|yes|1. Left as-is,
      // every soundbox row parsed as FALSE: in the real 360-row file that is
      // 137 merchants silently dispatched without the soundbox they asked for.
      // Normalized HERE, in the profile that knows this file's dialect, rather
      // than by widening parseBoolean for every future format.
      soundbox: /^y(es)?$/i.test((rec['Soundbox(Yes/No)'] ?? '').trim()) ? 'true' : 'false',
      standeeCount: rec['Standee Count'] ?? '',
      stickerCount: rec['Sticker Count'] ?? '',
      // The bank ships ONE address. Registered and ship-to are the same place
      // until a file carries them separately.
      shipToAddress: address,
      contactName: rec['Contact Name'] ?? '',
      mobile: rec['Mobile'] ?? '',
      branchCode: rec['Branch code'] ?? '',
    }
  },
}

// A file already written in canonical field names passes through untouched.
// This keeps every existing fixture, test, and hand-built file working exactly
// as before, so adding profiles is additive rather than a breaking change.
export const CANONICAL_PROFILE: BankSourceProfile = {
  name: 'canonical',
  signature: ['bankMerchantReference', 'displayName', 'vpaValue'],
  toCanonical(rec: SourceRecord): SourceRecord {
    return rec
  },
}

// Order matters only for readability: the signatures are disjoint by
// construction (canonical field names never appear as bank-facing headers).
export const BANK_SOURCE_PROFILES: readonly BankSourceProfile[] = [CANONICAL_PROFILE, ANNEXURE_B_PROFILE]

/**
 * Pick the profile whose signature the header satisfies, or null when none
 * does. A null result is NOT an error here: the caller falls back to the
 * canonical identity mapping so the existing missing-required-column
 * diagnostics still fire and name the columns the file lacks.
 */
export function selectBankSourceProfile(
  header: readonly string[],
  profiles: readonly BankSourceProfile[] = BANK_SOURCE_PROFILES,
): BankSourceProfile | null {
  const present = new Set(header.map((h) => h.trim()))
  return profiles.find((p) => p.signature.every((c) => present.has(c))) ?? null
}
