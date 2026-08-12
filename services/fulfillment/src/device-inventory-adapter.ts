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
// Validation contract, RULED at the 12 Aug 2026 product walkthrough (Workflow
// A, FROZEN): the ONLY row validation is that Device ID is PRESENT. The
// duplicate check (a serial already in inventory, or repeated within the
// file) lives downstream in the shared ingest (intake.ts), which is the other
// half of the same ruling. Sim No and Device QR are OPTIONAL PASS-THROUGH
// columns: parsed and carried when present, empty strings when absent, and
// NEVER a reason to reject a row or a file. This supersedes FR-01a's
// all-three-mandatory reading and the 2026-08-09 format lock that used to
// live in this file (see the note above parseDeviceInventoryFile).
//
// A missing Device ID COLUMN in the header is still a whole-file structural
// failure (structuralErrors), the same policy the bank adapter applies: the
// walkthrough's rule speaks to row validation, and a file with no Device ID
// column cannot satisfy it for any row, so one structural error beats N
// identical row errors.

// Canonical column names follow BRD Annexure E exactly. Matching is NORMALIZED
// (case-folded, surrounding and repeated whitespace collapsed) because the same
// column is spelled "Sim No" in the BRD and "SIM No" by some senders, and a
// difference of case is never a meaningful distinction between two columns
// here. This adapter previously required the literal "SIM No", so a file
// matching the BRD was rejected whole with zero rows ingested.
const REQUIRED_HEADERS = { deviceId: 'Device ID' } as const
const OPTIONAL_HEADERS = { simNo: 'Sim No', deviceQr: 'Device QR' } as const

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

export type DeviceInventoryRowErrorCode = 'missing_device_id'

/**
 * SUPERSEDED FORMAT LOCK, kept as history so nobody re-tightens by reflex.
 *
 * This spot used to hold the A-2 / D12 format bands (a 10-to-20 digit Device
 * ID pattern and a charset-plus-length Sim No pattern), LOCKED BY BHUPENDER
 * 2026-08-09 with the instruction not to improve them without a real CWD file
 * and a decision. The 12 Aug 2026 product walkthrough is that decision, and
 * it went the OTHER way: Workflow A is FROZEN with Device ID presence as the
 * ONLY row validation, no format rule at all, because ingestion must bend to
 * whatever the partners actually send and the duplicate check downstream is
 * the real gate. So the patterns are GONE, not widened.
 *
 * What survives from the old note, because it is still true and still useful:
 *  - The device id is taken from the `Device ID` COLUMN, never parsed back
 *    out of the Device QR blob (whose `DI` key mirrors it per BRD Annexure E,
 *    and whose key spelling is unreliable, e.g. `" DOM"` with a leading
 *    space).
 *  - The only per-ROW error is a blank Device ID; a bad row is reported and
 *    skipped while the rest of the file still ingests. Only a missing Device
 *    ID COLUMN fails the whole file.
 *  - Any future tightening (format bands, the QR DI cross-check) needs a NEW
 *    ruling that supersedes the 12 Aug walkthrough; do not reintroduce it
 *    quietly here.
 */

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

// Parses one device-inventory file (.csv or .xlsx) into per-row Device ID/Sim
// No/Device QR strings. Per the 12 Aug 2026 walkthrough (Workflow A, FROZEN):
// a row is invalid ONLY when its Device ID is blank (reported by rowNo, NOT
// ingested, without failing the file); Sim No and Device QR are optional
// pass-through values, empty strings when their column or cell is absent. A
// missing Device ID COLUMN in the header is a whole-file structural failure
// (structuralErrors) - this check runs BEFORE the zero-data-row check (fix
// round 1, Finding A: it previously ran after, so a headerless or no-data
// file returned a silent empty success instead of a rejection; a wholly blank
// file parses to `header: []` from parseGrid, which also fails this check). A
// file with a CORRECT header but zero data rows is a DELIBERATE, DIFFERENT
// case (an operator uploads the template with no rows yet): it is a
// legitimate empty upload, not a client error, so it returns empty
// validRows/invalidRows with NO structural error and the caller processes it
// as a genuine 0-row upload.
export async function parseDeviceInventoryFile(file: Uint8Array, filename: string): Promise<DeviceInventoryParseResult> {
  const parsed = await parseGrid(file, filename)
  if ('code' in parsed) return { validRows: [], invalidRows: [], structuralErrors: [parsed] }

  const { header, dataRows } = parsed

  // Both the presence check and the column lookup run on the SAME normalized
  // comparison, so a header that is accepted is always also locatable.
  const normalized = header.map(normalizeHeader)
  const indexOfHeader = (name: string): number => normalized.indexOf(normalizeHeader(name))

  const missing = (Object.keys(REQUIRED_HEADERS) as (keyof typeof REQUIRED_HEADERS)[])
    .filter((field) => indexOfHeader(REQUIRED_HEADERS[field]) === -1)
    .map((field) => ({
      code: 'missing_required_column' as const,
      message: `Missing required column "${REQUIRED_HEADERS[field]}".`,
      column: REQUIRED_HEADERS[field],
    }))
  if (missing.length > 0) return { validRows: [], invalidRows: [], structuralErrors: missing }

  if (dataRows.length === 0) return { validRows: [], invalidRows: [], structuralErrors: [] }

  const deviceIdIdx = indexOfHeader(REQUIRED_HEADERS.deviceId)
  // Optional columns: -1 when absent, and `cells[-1] ?? ''` reads as '', so an
  // absent column and a blank cell land on the same empty-string value.
  const simNoIdx = indexOfHeader(OPTIONAL_HEADERS.simNo)
  const deviceQrIdx = indexOfHeader(OPTIONAL_HEADERS.deviceQr)

  const validRows: DeviceInventoryRow[] = []
  const invalidRows: DeviceInventoryRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const deviceId = (cells[deviceIdIdx] ?? '').trim()
    const simNo = (cells[simNoIdx] ?? '').trim()
    const deviceQr = (cells[deviceQrIdx] ?? '').trim()

    // The one row check the walkthrough grants. No format rule: see the
    // superseded-lock note above.
    if (deviceId === '') {
      invalidRows.push({ rowNo, errors: ['missing_device_id'] })
      return
    }
    validRows.push({ rowNo, deviceId, simNo, deviceQr })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
