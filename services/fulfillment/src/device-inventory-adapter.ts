import ExcelJS from 'exceljs'

// Phase 5 Task 1 (D-G, FR-01a): the SERVER-SIDE structural parse for the CWD
// device-inventory sheet (.csv or .xlsx), mirroring the canonical grid-parse
// strategy services/tms/src/bank-file-adapter.ts already established (detect
// format by extension, read a plain string grid, drop wholly-blank rows,
// treat row 1 as the header). This module is a SEPARATE, self-contained copy
// rather than a shared-package import: bank-file-adapter.ts's own comment
// already documents this exact grid logic as a per-context port (not
// factored into a shared dependency), and a fulfillment-to-tms import would
// additionally be a cross-context code dependency this repo avoids. Pure: no
// DB, no network, no filesystem writes, and it never logs row content.
//
// FR-01a mandates Device ID, SIM No, AND Device QR ALL be present on every
// row. This is STRICTER than the vendor-channel intake's isStructurallyValid
// (intake.ts), which treats simNo as optional: a row here missing any of the
// three is an INVALID row, reported per-row (rowNo plus which field(s) were
// missing) and NOT ingested, WITHOUT failing the whole file. A missing
// REQUIRED COLUMN in the header, by contrast, IS a whole-file structural
// failure (structuralErrors), the same policy the bank adapter applies.

// Canonical column names follow BRD Annexure E exactly. Matching is NORMALIZED
// (case-folded, surrounding and repeated whitespace collapsed) because the same
// column is spelled "Sim No" in the BRD and "SIM No" by some senders, and a
// difference of case is never a meaningful distinction between two required
// columns here. This adapter previously required the literal "SIM No", so a
// file matching the BRD was rejected whole with zero rows ingested.
//
// Leniency stops at case and whitespace: a genuinely absent column still fails
// the whole file, and the error still names the column by its BRD spelling.
const HEADERS = { deviceId: 'Device ID', simNo: 'Sim No', deviceQr: 'Device QR' } as const

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ')
}

export type DeviceInventoryStructuralErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface DeviceInventoryStructuralError {
  code: DeviceInventoryStructuralErrorCode
  message: string
  // The canonical column this failure is about, taken from HEADERS above and so
  // entirely server-controlled. It exists as its own field because `message`
  // embeds the caller-supplied filename for two of the three codes and
  // therefore may never cross the HTTP boundary (S4/5c, see OpsErrorFilter);
  // this field may.
  column?: string
}

export interface DeviceInventoryRow {
  rowNo: number
  deviceId: string
  simNo: string
  deviceQr: string
}

export type DeviceInventoryRowErrorCode =
  | 'missing_device_id'
  | 'missing_sim_no'
  | 'missing_device_qr'
  | 'malformed_device_id'
  | 'malformed_sim_no'

/**
 * A-2 / D12, DELIBERATELY LOOSE. Tighten when a REAL CWD inventory file lands.
 *
 * Before this, the ONLY row check was non-empty, so `Device ID = ABCDEF` was
 * accepted and became a real unit. These bounds close that without pretending
 * to know a format we have not seen.
 *
 * WHY SO WIDE, measured 2026-08-09 against `docs/demo_files/`:
 *  - The CWD `sample_150` file is MOCK data (confirmed by Bhupender, and
 *    independently: its ICCIDs fail the Luhn check that real ICCIDs carry, and
 *    its 150 IMEIs have 150 DIFFERENT TACs, which real hardware of one model
 *    cannot). So its VALUES cannot found a rule, only its column shape.
 *  - The only real device ids we hold are the 98 in
 *    `Device id file from printer .xls`, and they are **12 OR 13 digits**, with
 *    no fixed prefix and no check digit.
 *  - A rule read off the mock file would have been `^784\d{10}$` (rejects 100%
 *    of the real file) or `^\d{13}$` (rejects 6% of it). Hence a wide band, not
 *    an exact length.
 *  - Sim No and Device QR have NO real-world evidence at all: the real file has
 *    neither column. Sim No is therefore charset-and-range only, and Device QR
 *    stays non-empty ONLY. Validating an unseen payload shape is exactly the
 *    mistake above.
 *
 * THE QR'S `DI` MIRRORS THE `Device ID` COLUMN. That is a BRD requirement
 * (Annexure E shows one row with `Device QR = {"DI":7846237843772,...}` beside
 * `Device ID = 7846237843772`), not an observation, so it is settled. Two
 * consequences:
 *  - The device id is taken from the `Device ID` COLUMN of the original file,
 *    never parsed back out of the QR blob. That is what this adapter does.
 *  - A cross-check (column must equal `DI`) is therefore AVAILABLE as a future
 *    tightening, and is the single highest-value one, because it catches a file
 *    whose two halves disagree. It is NOT applied yet, deliberately: the brief
 *    is to keep ingestion adaptable until real CWD files have been seen.
 *    Note the BRD's own example spells one key `" DOM"` WITH A LEADING SPACE
 *    where the mock file spells it `DOM`, so any future parse of this payload
 *    must be lenient about key spelling.
 *
 * These are per-ROW errors, so a bad row is reported and quarantined while the
 * rest of the file still ingests. Only a missing COLUMN fails the whole file.
 */
const DEVICE_ID_PATTERN = /^[0-9]{10,20}$/
const SIM_NO_PATTERN = /^[0-9A-Za-z]{10,30}$/

export interface DeviceInventoryRowError {
  rowNo: number
  errors: DeviceInventoryRowErrorCode[]
}

export interface DeviceInventoryParseResult {
  validRows: DeviceInventoryRow[]
  invalidRows: DeviceInventoryRowError[]
  structuralErrors: DeviceInventoryStructuralError[]
}

function detectFormat(filename: string): 'csv' | 'xlsx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

// Minimal hand-rolled CSV tokenizer: the same comma/newline-with-quote-escape
// grammar as bank-file-adapter.ts's tokenizeCsv (itself a direct port of
// apps/ops-portal/src/features/uploads/parseSheet.ts's parseCsv). Kept as a
// direct port rather than a new dependency, matching that file's own
// documented choice.
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
// same technique as bank-file-adapter.ts's readXlsxGrid.
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

async function parseGrid(file: Uint8Array, filename: string): Promise<ParsedGrid | DeviceInventoryStructuralError> {
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
      // Same duplicate-@types/node cast bank-file-adapter.ts documents at its
      // identical call site (exceljs's own dependency chain resolves a
      // different, older Buffer type than this file's Buffer.from; both are
      // the real Node Buffer class at runtime).
      await workbook.xlsx.load(Buffer.from(file) as unknown as Parameters<typeof workbook.xlsx.load>[0])
      grid = readXlsxGrid(workbook)
    }
  } catch {
    return { code: 'unreadable_file', message: `Failed to read "${filename}" as ${format.toUpperCase()}.` }
  }
  // Drop wholly blank rows (a trailing newline or a trailing formatted-but-
  // empty xlsx row), neither of which carries data.
  const nonBlank = grid.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonBlank.length === 0) return { header: [], dataRows: [] }
  const header = nonBlank[0]!.map((h) => h.trim())
  const dataRows = nonBlank.slice(1)
  return { header, dataRows }
}

// Parses one device-inventory file (.csv or .xlsx) into per-row Device ID/SIM
// No/Device QR strings, splitting rows into validRows (all three mandatory
// fields present) and invalidRows (missing at least one, reported by rowNo
// plus which field(s) were missing; NOT ingested). A missing required COLUMN
// in the header is a whole-file structural failure (structuralErrors) - this
// check runs BEFORE the zero-data-row check (fix round 1, Finding A: it
// previously ran after, so a headerless or no-data file returned a silent
// empty success instead of a rejection; a wholly blank file parses to
// `header: []` from parseGrid, which now also fails this check, all three
// columns reported missing). A file with a CORRECT header but zero data rows
// is a DELIBERATE, DIFFERENT case (an operator uploads the template with no
// rows yet): it is a legitimate empty upload, not a client error, so it
// returns empty validRows/invalidRows with NO structural error and the
// caller processes it as a genuine 0-row upload.
export async function parseDeviceInventoryFile(file: Uint8Array, filename: string): Promise<DeviceInventoryParseResult> {
  const parsed = await parseGrid(file, filename)
  if ('code' in parsed) return { validRows: [], invalidRows: [], structuralErrors: [parsed] }

  const { header, dataRows } = parsed

  // Both the presence check and the column lookup run on the SAME normalized
  // comparison, so a header that is accepted is always also locatable.
  const normalized = header.map(normalizeHeader)
  const indexOfHeader = (field: keyof typeof HEADERS): number =>
    normalized.indexOf(normalizeHeader(HEADERS[field]))

  const missing = (Object.keys(HEADERS) as (keyof typeof HEADERS)[])
    .filter((field) => indexOfHeader(field) === -1)
    .map((field) => ({
      code: 'missing_required_column' as const,
      message: `Missing required column "${HEADERS[field]}".`,
      column: HEADERS[field],
    }))
  if (missing.length > 0) return { validRows: [], invalidRows: [], structuralErrors: missing }

  if (dataRows.length === 0) return { validRows: [], invalidRows: [], structuralErrors: [] }

  const deviceIdIdx = indexOfHeader('deviceId')
  const simNoIdx = indexOfHeader('simNo')
  const deviceQrIdx = indexOfHeader('deviceQr')

  const validRows: DeviceInventoryRow[] = []
  const invalidRows: DeviceInventoryRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const deviceId = (cells[deviceIdIdx] ?? '').trim()
    const simNo = (cells[simNoIdx] ?? '').trim()
    const deviceQr = (cells[deviceQrIdx] ?? '').trim()

    const errors: DeviceInventoryRowErrorCode[] = []
    // Absent and malformed are DISTINCT codes, never collapsed: "the column was
    // blank" and "the value is not a device id" are different corrections for
    // the operator, and only the second suggests the file came from the wrong
    // source. Malformed is reported only when something IS present, so a blank
    // cell never produces both.
    if (deviceId === '') errors.push('missing_device_id')
    else if (!DEVICE_ID_PATTERN.test(deviceId)) errors.push('malformed_device_id')
    if (simNo === '') errors.push('missing_sim_no')
    else if (!SIM_NO_PATTERN.test(simNo)) errors.push('malformed_sim_no')
    // Device QR stays non-empty ONLY, on purpose. See the note above the
    // patterns: we have never seen a real one.
    if (deviceQr === '') errors.push('missing_device_qr')

    if (errors.length > 0) {
      invalidRows.push({ rowNo, errors })
      return
    }
    validRows.push({ rowNo, deviceId, simNo, deviceQr })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
