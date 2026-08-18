import ExcelJS from 'exceljs'
import { UNIT_STATUS_ORDER, UNIT_TERMINAL_STATUSES } from './unit-lifecycle.js'

// The SERVER-SIDE structural parse for the bulk unit-status sheet (2026-08-13
// ruling: two options for a manual status move, one by one from the device
// page, or a sheet for many at once - this is the second). Same grid-parse
// strategy as device-inventory-adapter.ts (detect format by extension, read a
// plain string grid, drop wholly-blank rows, row 1 is the header); kept as its
// own self-contained copy rather than an import from that module, matching
// this codebase's own documented convention for these small per-file adapters.

// Exported so workbook-sniff.ts can match on this file's OWN accepted column
// names rather than a hand-typed second copy that could drift from them.
export const HEADERS = { deviceId: 'Device ID', newStatus: 'Status' } as const

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ')
}

const DEVICE_ID_PATTERN = /^[0-9]{10,20}$/
const KNOWN_STATUSES: readonly string[] = [...UNIT_STATUS_ORDER, ...UNIT_TERMINAL_STATUSES]

export type UnitStatusStructuralErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface UnitStatusStructuralError {
  code: UnitStatusStructuralErrorCode
  message: string
  column?: string
}

export interface UnitStatusRow {
  rowNo: number
  deviceId: string
  newStatus: string
}

export type UnitStatusRowErrorCode = 'missing_device_id' | 'malformed_device_id' | 'missing_new_status' | 'unknown_status'

export interface UnitStatusRowError {
  rowNo: number
  errors: UnitStatusRowErrorCode[]
}

export interface UnitStatusParseResult {
  validRows: UnitStatusRow[]
  invalidRows: UnitStatusRowError[]
  structuralErrors: UnitStatusStructuralError[]
}

function detectFormat(filename: string): 'csv' | 'xlsx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

// Same comma/newline-with-quote-escape grammar as every other adapter in this
// repo (bank-file-adapter.ts, device-inventory-adapter.ts).
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

async function parseGrid(file: Uint8Array, filename: string): Promise<ParsedGrid | UnitStatusStructuralError> {
  const format = detectFormat(filename)
  if (!format) {
    return { code: 'unsupported_extension', message: `Unsupported file extension for "${filename}"; expected .csv or .xlsx.` }
  }
  let grid: string[][]
  try {
    if (format === 'csv') {
      grid = readCsvGrid(file)
    } else {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(file) as unknown as Parameters<typeof workbook.xlsx.load>[0])
      grid = readXlsxGrid(workbook)
    }
  } catch {
    return { code: 'unreadable_file', message: `Failed to read "${filename}" as ${format.toUpperCase()}.` }
  }
  const nonBlank = grid.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonBlank.length === 0) return { header: [], dataRows: [] }
  const header = nonBlank[0]!.map((h) => h.trim())
  const dataRows = nonBlank.slice(1)
  return { header, dataRows }
}

// Parses one bulk unit-status file into per-row Device ID / New Status pairs.
// A row's `newStatus` is checked here only for being a KNOWN status string
// (spelled correctly); whether it is a LEGAL move from that device's CURRENT
// status is a per-row, DB-dependent question the ops mutation answers at
// commit time (mirrors the device-inventory preview's already-in-stock check:
// this parser cannot know it, and preview/commit share it from one place).
export async function parseUnitStatusFile(file: Uint8Array, filename: string): Promise<UnitStatusParseResult> {
  const parsed = await parseGrid(file, filename)
  if ('code' in parsed) return { validRows: [], invalidRows: [], structuralErrors: [parsed] }

  const { header, dataRows } = parsed
  const normalized = header.map(normalizeHeader)
  const indexOfHeader = (field: keyof typeof HEADERS): number => normalized.indexOf(normalizeHeader(HEADERS[field]))

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
  const newStatusIdx = indexOfHeader('newStatus')

  const validRows: UnitStatusRow[] = []
  const invalidRows: UnitStatusRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const deviceId = (cells[deviceIdIdx] ?? '').trim()
    // Matched case-insensitively against the closed vocabulary, then
    // normalized to the canonical uppercase spelling the domain expects -
    // the same "lenient in, strict internally" rule the header match applies.
    const newStatusRaw = (cells[newStatusIdx] ?? '').trim()
    const newStatus = newStatusRaw.toUpperCase()

    const errors: UnitStatusRowErrorCode[] = []
    if (deviceId === '') errors.push('missing_device_id')
    else if (!DEVICE_ID_PATTERN.test(deviceId)) errors.push('malformed_device_id')
    if (newStatusRaw === '') errors.push('missing_new_status')
    else if (!KNOWN_STATUSES.includes(newStatus)) errors.push('unknown_status')

    if (errors.length > 0) {
      invalidRows.push({ rowNo, errors })
      return
    }
    validRows.push({ rowNo, deviceId, newStatus })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
