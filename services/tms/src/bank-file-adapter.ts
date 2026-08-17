import ExcelJS from 'exceljs'
import type { BankRequestRow } from './ingest.js'
import { selectBankSourceProfile, BANK_SOURCE_PROFILES, type BankSourceProfile } from './bank-source-profile.js'

// Phase 2 Task 1 (D-C core): the server-side bank-file parse and normalize
// adapter. Today (Phase 1) `apps/ops-portal/src/features/uploads/parseSheet.ts`
// parses in the browser and the server only ever sees a JSON rows array; this
// module is the SERVER-SIDE replacement parser, built once here so a later
// task can wire it behind the upload edge. It is pure: no DB, no network, no
// filesystem writes, no persistence, and it never logs row content (bank rows
// carry PII, S4/5c). Row-level business validation (QR/VPA format, mandatory
// contact) is NOT this module's job; that stays in services/tms/src/ingest.ts,
// which a later task calls with this adapter's output. This module only
// reports STRUCTURAL parse errors: unreadable bytes, an unsupported extension,
// or a missing required column.
//
// D-25 (Damage and Replacement Workflow, 16 Aug 2026): the damage half of this
// adapter (its column mapping, normalizer, and parseBankDamageFile) is GONE.
// There is no damage file ingestion anymore; an operator flags a damaged
// dispatch in the screen (services/tms/src/flag-damage.ts). The bank REQUEST
// path below is untouched.

/**
 * Canonical-field name to source-header name. Config-as-code: today every
 * bank ships the same fixed columns, so the DEFAULT mapping below is the
 * identity mapping (canonical field name equals the header the file must
 * carry). Phase 3 can add per-bank overrides by keeping a
 * `Record<bankIdWire, BankColumnMapping>` alongside these defaults and
 * passing the resolved mapping in as the `mapping` argument; this module
 * itself takes no bank identifier and wires to no bank master, only an
 * optional mapping that defaults to the DEFAULT below.
 */
export type BankColumnMapping = Readonly<Record<string, string>>

export const DEFAULT_REQUEST_COLUMN_MAPPING: BankColumnMapping = Object.freeze({
  bankMerchantReference: 'bankMerchantReference',
  displayName: 'displayName',
  legalName: 'legalName',
  mcc: 'mcc',
  registeredAddress: 'registeredAddress',
  bankReferenceCode: 'bankReferenceCode',
  productType: 'productType',
  vpaValue: 'vpaValue',
  // KNOWN BANK QUIRK, carried through this column UNCHANGED on purpose. GSCB's
  // export HTML-escapes the first query separator of every UPI payload, so the
  // value arrives as `upi://pay?ver=01&amp;mode=01&pa=...` and a scanner reads
  // a junk `amp;mode` parameter. This adapter does NOT correct it: D117/T2
  // (services/tms/src/internal.ts) says TMS validates format only and never
  // alters the value, so the fact stream keeps what the bank actually sent.
  // The correction happens at the artifact boundary in fulfillment, in
  // the @andpay/bank-qr package, which documents the whole defect.
  qrValue: 'qrValue',
  soundbox: 'soundbox',
  standeeCount: 'standeeCount',
  stickerCount: 'stickerCount',
  shipToAddress: 'shipToAddress',
  contactName: 'contactName',
  mobile: 'mobile',
  branchCode: 'branchCode',
  vpaHint: 'vpaHint',
  // LAST on purpose. services/tms/test/bank-file-adapter.test.ts derives its
  // CSV header from Object.values of this map and pairs it with a POSITIONAL
  // data row, so inserting a field in the middle silently shifts every value
  // after it. Trailing optional fields keep that fixture aligned.
  tenantReference: 'tenantReference',
})

// vpaHint and tenantReference are the OPTIONAL request fields (see ingest.ts);
// every other canonical field on the row shape is required.
const REQUEST_OPTIONAL_FIELDS = ['vpaHint', 'tenantReference']
const REQUEST_REQUIRED_FIELDS = Object.keys(DEFAULT_REQUEST_COLUMN_MAPPING).filter(
  (f) => !REQUEST_OPTIONAL_FIELDS.includes(f),
)

export type StructuralParseErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface StructuralParseError {
  code: StructuralParseErrorCode
  message: string
}

export interface BankRequestParseResult {
  rows: BankRequestRow[]
  errors: StructuralParseError[]
}

function detectFormat(filename: string): 'csv' | 'xlsx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

// Minimal hand-rolled CSV tokenizer, ported from
// apps/ops-portal/src/features/uploads/parseSheet.ts's parseCsv (a
// comma/newline split with double-quote handling: "" escapes a literal
// quote, a quoted field may contain commas or newlines). Kept as a direct
// port rather than a new dependency per the brief; a small well-tested CSV
// library would likely be a cleaner long-term choice, noted as a concern in
// the task report rather than added silently here.
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const len = text.length
  while (i < len) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function readCsvGrid(file: Uint8Array): string[][] {
  const text = new TextDecoder('utf-8').decode(file)
  return tokenizeCsv(text)
}

// Reads a worksheet into a plain string grid via ExcelJS's cell.text getter,
// which normalizes numbers, booleans, dates, formulas, and rich text to a
// display string, so the grid this returns is directly comparable to the CSV
// grid above. Column count is taken from the header row (row 1) so every
// data row is read out to the same width regardless of trailing empty cells.
function readXlsxGrid(workbook: ExcelJS.Workbook): string[][] {
  const ws = workbook.worksheets[0]
  if (!ws || ws.rowCount === 0) return []
  const headerRow = ws.getRow(1)
  const ncols = Math.max(headerRow.cellCount, headerRow.actualCellCount)
  const grid: string[][] = []
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r)
    const cells: string[] = []
    for (let c = 1; c <= ncols; c += 1) {
      cells.push(row.getCell(c).text ?? '')
    }
    grid.push(cells)
  }
  return grid
}

interface ParsedGrid {
  header: string[]
  dataRows: string[][]
}

async function parseGrid(file: Uint8Array, filename: string): Promise<ParsedGrid | StructuralParseError> {
  const format = detectFormat(filename)
  if (!format) {
    return {
      code: 'unsupported_extension',
      message: `Unsupported file extension for "${filename}"; expected .csv or .xlsx.`,
    }
  }
  let grid: string[][]
  try {
    if (format === 'csv') {
      grid = readCsvGrid(file)
    } else {
      const workbook = new ExcelJS.Workbook()
      // exceljs's own dependency chain (fast-csv, a production dependency of
      // exceljs itself) pulls in its own @types/node@14 alongside this repo's
      // @types/node@22, so exceljs's `load(buffer: Buffer, ...)` parameter
      // resolves to a DIFFERENT (older, non-generic) `Buffer` type than the
      // one this file's `Buffer.from` returns. Both are the real Node Buffer
      // class at runtime; this is a duplicate-@types/node artifact of the
      // dependency tree, not a real type error, so it is cast through
      // `unknown` at this one call site rather than routed around.
      await workbook.xlsx.load(Buffer.from(file) as unknown as Parameters<typeof workbook.xlsx.load>[0])
      grid = readXlsxGrid(workbook)
    }
  } catch {
    return { code: 'unreadable_file', message: `Failed to read "${filename}" as ${format.toUpperCase()}.` }
  }
  // Drop wholly blank rows (every field empty): a CSV trailing newline or an
  // xlsx trailing formatted-but-empty row, neither of which carries data.
  const nonBlank = grid.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonBlank.length === 0) return { header: [], dataRows: [] }
  const header = nonBlank[0]!.map((h) => h.trim())
  const dataRows = nonBlank.slice(1)
  return { header, dataRows }
}

function toRecords(header: string[], dataRows: string[][]): Record<string, string>[] {
  return dataRows.map((r) => {
    const rec: Record<string, string> = {}
    header.forEach((h, idx) => {
      rec[h] = (r[idx] ?? '').trim()
    })
    return rec
  })
}

function missingRequiredColumns(header: string[], mapping: BankColumnMapping, requiredFields: string[]): StructuralParseError[] {
  return requiredFields
    .filter((field) => !header.includes(mapping[field] ?? field))
    .map((field) => ({
      code: 'missing_required_column' as const,
      message: `Missing required column "${mapping[field] ?? field}" (field "${field}").`,
    }))
}

function parseBoolean(value: string): boolean {
  return /^(true|yes|1)$/i.test(value.trim())
}

function parseCount(value: string): number {
  return Number(value.trim() === '' ? '0' : value.trim())
}

function normalizeRequestRow(
  rec: Record<string, string>,
  mapping: BankColumnMapping,
  fileId: string,
  rowNo: number,
): BankRequestRow {
  const get = (field: string) => rec[mapping[field] ?? field] ?? ''
  const row: BankRequestRow = {
    fileId,
    rowNo,
    bankMerchantReference: get('bankMerchantReference'),
    displayName: get('displayName'),
    legalName: get('legalName'),
    mcc: get('mcc'),
    registeredAddress: get('registeredAddress'),
    bankReferenceCode: get('bankReferenceCode'),
    productType: get('productType'),
    vpaValue: get('vpaValue'),
    qrValue: get('qrValue'),
    soundbox: parseBoolean(get('soundbox')),
    standeeCount: parseCount(get('standeeCount')),
    stickerCount: parseCount(get('stickerCount')),
    shipToAddress: get('shipToAddress'),
    contactName: get('contactName'),
    mobile: get('mobile'),
    branchCode: get('branchCode'),
  }
  const tenantReference = get('tenantReference')
  const withTenant = tenantReference === '' ? row : { ...row, tenantReference }
  const vpaHint = get('vpaHint')
  return vpaHint === '' ? withTenant : { ...withTenant, vpaHint }
}

async function parseBankFile<T>(
  file: Uint8Array,
  filename: string,
  fileId: string,
  mapping: BankColumnMapping,
  requiredFields: string[],
  normalize: (rec: Record<string, string>, mapping: BankColumnMapping, fileId: string, rowNo: number) => T,
  profiles?: readonly BankSourceProfile[],
): Promise<{ rows: T[]; errors: StructuralParseError[] }> {
  const parsed = await parseGrid(file, filename)
  if ('code' in parsed) return { rows: [], errors: [parsed] }

  const { header, dataRows } = parsed

  // P3-3: reshape a bank-native layout into canonical field names BEFORE the
  // required-column check, so the rest of this function is unchanged. A file
  // that matches no profile falls through with `profile === null` and gets the
  // exact diagnostics it got before: the missing-column errors naming what the
  // canonical mapping wanted. `profiles` stays optional: a caller that passes
  // none opts out of profile selection entirely.
  const profile = profiles === undefined ? null : selectBankSourceProfile(header, profiles)

  // The UNION of the file's own header and the profile's OUTPUT keys. Taking
  // only the profile's keys breaks the pass-through canonical profile, whose
  // toCanonical is the identity function and therefore yields nothing at all
  // for an empty probe record. Taking only the header breaks the Annexure B
  // profile, whose derived fields are in no header. Deriving the profile keys
  // from a probe rather than from the data keeps a header-only file correct.
  const effectiveHeader =
    profile === null ? header : [...header, ...Object.keys(profile.toCanonical({}))]

  // The profile's own required SOURCE columns, checked FIRST and separately
  // (D-4, 12 Aug 2026). This has to run before the canonical check below,
  // because that check consults the profile's advertised OUTPUT keys and so
  // cannot see that a source column behind one of them is missing: toCanonical
  // defaults it to ''. The error names the column by the spelling the bank uses,
  // which is the only spelling they can act on. See requiredSourceColumns in
  // bank-source-profile.ts for why this is not simply more signature.
  const missingSource: StructuralParseError[] =
    profile === null
      ? []
      : (profile.requiredSourceColumns ?? [])
          .filter((column) => !header.includes(column))
          .map((column) => ({
            code: 'missing_required_column' as const,
            message: `Missing required column "${column}".`,
          }))
  if (missingSource.length > 0) return { rows: [], errors: missingSource }

  const missing = missingRequiredColumns(effectiveHeader, mapping, requiredFields)
  if (missing.length > 0) return { rows: [], errors: missing }

  const raw = toRecords(header, dataRows)
  const records = profile === null ? raw : raw.map((rec) => profile.toCanonical(rec))
  const rows = records.map((rec, idx) => normalize(rec, mapping, fileId, idx + 1))
  return { rows, errors: [] }
}

// Parses a bank request file (.csv or .xlsx) into BankRequestRow[], assigning
// ONE caller-supplied fileId to every row and rowNo = the row's 1-based data
// index (the header row is never counted). Interchangeable with what
// services/tms/src/ingest.ts's ingestRequestRow/ingestRequestRowWithinTx
// already consume; this function does no business validation itself.
export function parseBankRequestFile(
  file: Uint8Array,
  filename: string,
  fileId: string,
  mapping: BankColumnMapping = DEFAULT_REQUEST_COLUMN_MAPPING,
  profiles: readonly BankSourceProfile[] = BANK_SOURCE_PROFILES,
): Promise<BankRequestParseResult> {
  return parseBankFile(file, filename, fileId, mapping, REQUEST_REQUIRED_FIELDS, normalizeRequestRow, profiles)
}
