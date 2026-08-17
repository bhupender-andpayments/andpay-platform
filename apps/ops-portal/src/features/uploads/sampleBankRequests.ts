import { csvLine } from '../../lib/csv.js'

// TESTING AID, not a product surface. Generates one bank request file that
// previews and commits cleanly every time it is downloaded. Sibling of
// features/inventory/sampleInventory.ts; same reasoning, harder contract.
//
// WHY IT EXISTS. The checked-in 5-bank-demo.csv is deliberately NOT a clean
// file: it carries one bad mobile and one duplicate VPA, because showing the
// two failure modes is the point of that asset. And its VPAs are fixed, so
// even its three good rows commit only once. A demo that needs a file which
// simply WORKS, twice, had nothing to reach for.
//
// WHICH LAYOUT. The real GSCB Annexure B shape (header spellings taken from
// From Bank_GSCB_upi_Active_terminal_CWD_Data, the 360 row file), NOT the
// canonical field names 5-bank-demo.csv uses. Two reasons: it is what a bank
// actually sends, and it exercises the source-profile resolution this page
// advertises ("Column names are resolved against the bank's own layout"), so
// the preview's "N columns recognised" line reports something real.
//
// WHAT MAKES A ROW PASS. Every rule below is enforced in
// services/tms/src/ingest.ts requestRowRejectReason, and each field here is
// shaped to clear exactly one of them. The profile that maps these headers to
// canonical fields is ANNEXURE_B_PROFILE in services/tms/src/bank-source-profile.ts.
//   - profile signature: Business Name, VPA, Bank code, Mobile must ALL be
//     present or the file is not recognised as this layout at all.
//   - QR String is a requiredSourceColumn: recognised but absent rejects the
//     WHOLE file, by design, so the operator is told to add one column rather
//     than handed 360 per-row failures.
//   - qrValue must be non-empty and start with `upi:`, vpaValue must match
//     `[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+`.
//   - displayName, legalName, registeredAddress non-blank after trimming;
//     Contact Name and Mobile non-empty; Mobile EXACTLY 10 digits.
//   - Category Code 3 to 4 digits; Bank code and Branch code digits only,
//     variable length; Branch code is mandatory.
//   - Standee/Sticker counts non-negative integers.
//
// AND THE ONE THAT MAKES IT REPEATABLE. A soundbox row whose VPA is already in
// the system is HELD with duplicate_vpa_soundbox (ruling 2026-08-10) and lands
// in Queues rather than committing. Merchant identity is VPA-derived today
// (`v1:vpa:<lower(vpa)>`, the D1 interim), so a fresh VPA per row per download
// is what makes both the hold and a merchant collision unreachable.
//
// ONE DELIBERATE DIVERGENCE FROM THE REAL FILE. The genuine GSCB export
// HTML-escapes the first query separator (`&amp;mode=01`), the one known defect
// @andpay/bank-qr detects and corrects. This generator emits CLEAN separators,
// because a sample whose whole purpose is "nothing is wrong with this file"
// should not also be exercising a bank-side bug. Use the real file in
// docs/demo_files/ when the defect handling is what is being shown.

/**
 * The real GSCB header, verbatim and in file order. `Email ID` and `QR Type`
 * are carried because the real file has them; the profile ignores both.
 */
const HEADER = [
  'Business Name',
  'Contact Name',
  'Mobile',
  'Email ID',
  'Category Code',
  'Legal Name',
  'Address',
  'Address2',
  'Address3',
  'City',
  'State',
  'Pincode',
  'Bank code',
  'Branch code',
  'QR Type',
  'VPA',
  'QR String',
  'Soundbox(Yes/No)',
  'Standee Count',
  'Sticker Count',
] as const

/** Rows per download, matching the checked-in 5-bank-demo.csv. */
export const SAMPLE_BANK_ROW_COUNT = 5

/**
 * Merchant identities, fixed so the file reads like a real one. NONE of these
 * makes a row unique: the VPA does that. Deliberately comma-free and
 * apostrophe-free so a reader can eyeball the raw CSV without quoting noise.
 */
const MERCHANTS = [
  { name: 'ANAND KIRANA STORES', legal: 'ANAND KIRANA LLP', mcc: '5411', contact: 'Priya Menon' },
  { name: 'MEERA SWEET HOUSE', legal: 'MEERA SWEETS LLP', mcc: '5462', contact: 'Arun Gupta' },
  { name: 'RAVI MEDICAL STORE', legal: 'RAVI MEDICALS PVT LTD', mcc: '5912', contact: 'Ravi Shankar' },
  { name: 'SUNRISE HARDWARE', legal: 'SUNRISE HARDWARE LLP', mcc: '5251', contact: 'Neha Joshi' },
  { name: 'GREEN LEAF GROCERY', legal: 'GREEN LEAF RETAIL LLP', mcc: '5411', contact: 'Imran Sheikh' },
] as const

/** Addresses, split across the three columns the real export uses. */
const ADDRESSES = [
  { line1: 'SHOP NO 14 TEMPLE ROAD', line2: 'NEAR CITY MARKET', line3: 'WARD 6', city: 'AHMEDABAD', state: 'Gujarat', pin: '380008' },
  { line1: 'SHOP NO 29 CHURCH STREET', line2: 'OPP BUS DEPOT', line3: 'NIKOL', city: 'AHMEDABAD', state: 'Gujarat', pin: '382350' },
  { line1: 'PLOT 7 STATION ROAD', line2: 'ABOVE STATE BANK', line3: 'MANI NAGAR', city: 'AHMEDABAD', state: 'Gujarat', pin: '380001' },
  { line1: 'UNIT 3 INDUSTRIAL ESTATE', line2: 'PHASE II', line3: 'VATVA', city: 'AHMEDABAD', state: 'Gujarat', pin: '382445' },
  { line1: 'SHOP 22 MARKET YARD', line2: 'GATE NO 4', line3: 'NARODA', city: 'AHMEDABAD', state: 'Gujarat', pin: '382330' },
] as const

/** Branch codes, digits only and variable length, as the real file carries. */
const BRANCH_CODES = ['30', '6', '112', '4', '18'] as const

/** The aggregator code. `3` is a real GSCB member bank code from the sample. */
const BANK_CODE = '3'

export interface SampleBankFile {
  filename: string
  csv: string
  vpas: string[]
}

function digits(n: number, width: number): string {
  return String(n).padStart(width, '0').slice(-width)
}

/**
 * A 12 character lowercase alphanumeric VPA local part, matching the shape the
 * real file uses (`w7dgo921gdqa@gscb`) and new on every call.
 *
 * Uniqueness comes from the epoch millisecond in base 36, which is monotonic,
 * plus a per-run salt and the row index. It stays inside the ingest VPA pattern
 * `[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+` because base 36 emits only [0-9a-z].
 */
function vpaFor(runMs: number, runSalt: number, rowIndex: number): string {
  const stamp = runMs.toString(36)
  const salt = runSalt.toString(36).padStart(2, '0')
  return `d${stamp}${salt}${rowIndex}@gscb`
}

/**
 * The UPI payload, with CLEAN `&` separators (see the divergence note above).
 * `pa` mirrors the VPA and `mc` the category code, as the real export does.
 */
function qrStringFor(vpa: string, businessName: string, mcc: string): string {
  return `upi://pay?ver=01&mode=01&pa=${vpa}&pn=${businessName}&mc=${mcc}&qrMedium=06`
}

/**
 * Builds one bank request file whose rows all commit. `now` and `salt` are
 * injected so a test can pin the output; production callers pass nothing.
 */
export function buildSampleBankFile(
  now: Date = new Date(),
  salt: number = Math.floor(Math.random() * 100),
): SampleBankFile {
  const runMs = now.getTime()
  const vpas: string[] = []
  const lines: string[] = [csvLine([...HEADER])]

  for (let i = 1; i <= SAMPLE_BANK_ROW_COUNT; i += 1) {
    const m = MERCHANTS[(i - 1) % MERCHANTS.length]!
    const a = ADDRESSES[(i - 1) % ADDRESSES.length]!
    const vpa = vpaFor(runMs, salt, i)
    vpas.push(vpa)
    lines.push(
      csvLine([
        m.name,
        m.contact,
        // Exactly 10 digits. Leading 9 keeps it a plausible Indian mobile, and
        // the tail varies per row so two rows never look like one contact.
        `9${digits(runMs, 7)}${digits(i, 2)}`,
        '',
        m.mcc,
        m.legal,
        a.line1,
        a.line2,
        a.line3,
        a.city,
        a.state,
        a.pin,
        BANK_CODE,
        BRANCH_CODES[(i - 1) % BRANCH_CODES.length]!,
        '',
        vpa,
        qrStringFor(vpa, m.name, m.mcc),
        // Y, not TRUE: the real file ships single letters and the profile
        // normalizes them. A soundbox row is what makes the demo interesting.
        'Y',
        '1',
        '2',
      ]),
    )
  }

  return {
    filename: `sample-bank-requests-${now.toISOString().slice(0, 10)}-${digits(runMs, 6)}${digits(salt, 2)}.csv`,
    csv: `${lines.join('\n')}\n`,
    vpas,
  }
}
