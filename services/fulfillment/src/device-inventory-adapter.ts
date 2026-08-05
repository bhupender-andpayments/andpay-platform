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

const HEADERS = { deviceId: 'Device ID', simNo: 'SIM No', deviceQr: 'Device QR' } as const

export type DeviceInventoryStructuralErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface DeviceInventoryStructuralError {
  code: DeviceInventoryStructuralErrorCode
  message: string
}

export interface DeviceInventoryRow {
  rowNo: number
  deviceId: string
  simNo: string
  deviceQr: string
}

export type DeviceInventoryRowErrorCode = 'missing_device_id' | 'missing_sim_no' | 'missing_device_qr'

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
// in the header is a whole-file structural failure (structuralErrors); an
// empty file (no data rows) returns empty validRows/invalidRows with no
// error, never a crash.
export async function parseDeviceInventoryFile(file: Uint8Array, filename: string): Promise<DeviceInventoryParseResult> {
  const parsed = await parseGrid(file, filename)
  if ('code' in parsed) return { validRows: [], invalidRows: [], structuralErrors: [parsed] }

  const { header, dataRows } = parsed
  if (dataRows.length === 0) return { validRows: [], invalidRows: [], structuralErrors: [] }

  const missing = (Object.keys(HEADERS) as (keyof typeof HEADERS)[])
    .filter((field) => !header.includes(HEADERS[field]))
    .map((field) => ({
      code: 'missing_required_column' as const,
      message: `Missing required column "${HEADERS[field]}".`,
    }))
  if (missing.length > 0) return { validRows: [], invalidRows: [], structuralErrors: missing }

  const deviceIdIdx = header.indexOf(HEADERS.deviceId)
  const simNoIdx = header.indexOf(HEADERS.simNo)
  const deviceQrIdx = header.indexOf(HEADERS.deviceQr)

  const validRows: DeviceInventoryRow[] = []
  const invalidRows: DeviceInventoryRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const deviceId = (cells[deviceIdIdx] ?? '').trim()
    const simNo = (cells[simNoIdx] ?? '').trim()
    const deviceQr = (cells[deviceQrIdx] ?? '').trim()

    const errors: DeviceInventoryRowErrorCode[] = []
    if (deviceId === '') errors.push('missing_device_id')
    if (simNo === '') errors.push('missing_sim_no')
    if (deviceQr === '') errors.push('missing_device_qr')

    if (errors.length > 0) {
      invalidRows.push({ rowNo, errors })
      return
    }
    validRows.push({ rowNo, deviceId, simNo, deviceQr })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
