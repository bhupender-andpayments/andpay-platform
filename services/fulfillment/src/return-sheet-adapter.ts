import ExcelJS from 'exceljs'
import type { ReturnRow } from './return-sheet.js'

/**
 * D-4 / F8: parse the print vendor's RETURN WORKBOOK into `ReturnRow[]`.
 *
 * WHY THIS EXISTS. The return route accepted JSON and nothing else, while the
 * real artifact is a spreadsheet: BRD Phase 1 is "print vendor emails the
 * Excel, AndPayments uploads it". So the Phase-1 return flow could not work at
 * all. Measured against the partner's actual file
 * (`Device id file from printer .xls`, 99 rows) the gap was threefold: format,
 * column layout, and a missing AWB.
 *
 * WHAT WE REQUIRE, and why it is a REQUIREMENT rather than an accommodation
 * (ruled by Bhupender 2026-08-09): the vendor returns OUR dispatch sheet with
 * `Device ID` and `AWB` filled in. Their current file carries `Device ID` but
 * NO AWB anywhere, verified by header scan and by value scan. Without an AWB
 * there is no shipment to create and nothing for courier status to attach to,
 * so accepting a file without one would only defer the failure to a later,
 * quieter place. The BRD already says the return file carries both; their
 * present file predates this system. See
 * `docs/plan/RETURN_TEMPLATE_2026-08-09.md` for the template we publish.
 *
 * LEGACY .xls IS REJECTED EXPLICITLY, and this is the subtle one. ExcelJS does
 * NOT throw on a BIFF8 `.xls`: it returns a workbook with ZERO worksheets, so a
 * naive reader reports "empty file" for what is really "wrong format". The
 * partner sends `.xls` today, so this would have been the FIRST thing they hit
 * and the least diagnosable. Extension detection refuses it by name, and the
 * empty-workbook case is reported as its own structural error rather than as an
 * empty sheet.
 */

export interface ReturnSheetRowError {
  rowNo: number
  errors: ReturnSheetRowErrorCode[]
}
// `missing_device_id` IS GONE, deliberately, and its absence is the feature.
// A row with a Dispatch ID and an AWB but NO Device ID is now MEANINGFUL: it
// reports a collateral-only consignment for that dispatch id (one dispatch id
// can travel under two AWBs, the kit under one and the standee under another).
// The Device ID COLUMN is still required in the header below, so the round trip
// with the sheet we send is unchanged; only the VALUE became optional.
export type ReturnSheetRowErrorCode = 'missing_assignment' | 'missing_awb'

export interface ReturnSheetStructuralError {
  code: 'unsupported_extension' | 'unreadable_file' | 'empty_sheet' | 'missing_column'
  message: string
}

export interface ReturnSheetParseResult {
  validRows: ReturnRow[]
  invalidRows: ReturnSheetRowError[]
  structuralErrors: ReturnSheetStructuralError[]
}

// The columns we require the vendor to return. `Assignment` and the merchant
// block come from the sheet WE sent; `Device ID` and `AWB` are what they add.
// `Courier` is optional and resolves to a vndr_ COURIER via vndr.courier_code.
/**
 * Each field accepts SYNONYMS, and that is a fix rather than leniency for its
 * own sake. The two ends of this round trip disagreed on a column name:
 * `dispatchXlsx` sends the column as **`Assignment`**, while the vendor
 * portal's client-side return parser requires **`Dispatch ID`** (which is the
 * BRD's own term, used in its report definitions). So a vendor who returned our
 * sheet with Device ID and AWB filled in, exactly as instructed, would have been
 * REJECTED for a missing column. Accepting both names fixes the round trip
 * without renaming a column that has already shipped in downloaded workbooks.
 * Same for `Courier` versus the portal's `Courier Partner`.
 */
const HEADERS = {
  asgnId: ['Assignment', 'Dispatch ID'],
  deviceSerial: ['Device ID'],
  awb: ['AWB'],
  courierCode: ['Courier', 'Courier Partner'],
} as const

function detectFormat(filename: string): 'csv' | 'xlsx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

// Same comma/newline-with-quote-escape grammar as the other adapters in this
// service, kept as a direct port rather than a new dependency, matching their
// own documented choice.
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
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
    for (let c = 1; c <= ncols; c += 1) cells.push(row.getCell(c).text ?? '')
    grid.push(cells)
  }
  return grid
}

export async function parseReturnWorkbook(
  file: Uint8Array,
  filename: string,
): Promise<ReturnSheetParseResult> {
  const fail = (e: ReturnSheetStructuralError): ReturnSheetParseResult => ({
    validRows: [],
    invalidRows: [],
    structuralErrors: [e],
  })

  const format = detectFormat(filename)
  if (!format) {
    return fail({
      code: 'unsupported_extension',
      message: `Unsupported file extension for "${filename}"; expected .csv or .xlsx. A legacy .xls must be re-saved as .xlsx.`,
    })
  }

  let grid: string[][]
  try {
    if (format === 'csv') {
      grid = tokenizeCsv(new TextDecoder().decode(file))
    } else {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(file as unknown as Parameters<typeof wb.xlsx.load>[0])
      // A BIFF8 .xls renamed to .xlsx lands here with ZERO worksheets rather
      // than throwing. Reporting that as "empty sheet" would send the operator
      // hunting for missing rows in a file that is full of them, so it gets its
      // own message naming the real cause.
      if (wb.worksheets.length === 0) {
        return fail({
          code: 'unreadable_file',
          message: `"${filename}" has no readable worksheet. A legacy .xls saved with an .xlsx name does this; re-save it as a real .xlsx.`,
        })
      }
      grid = readXlsxGrid(wb)
    }
  } catch {
    return fail({ code: 'unreadable_file', message: `"${filename}" could not be read as ${format}.` })
  }

  if (grid.length === 0) return fail({ code: 'empty_sheet', message: `"${filename}" has no rows.` })

  const header = (grid[0] ?? []).map((h) => h.trim())
  // First synonym that matches wins; -1 when none do.
  const indexOf = (names: readonly string[]): number =>
    header.findIndex((h) => names.some((n) => h.toLowerCase() === n.toLowerCase()))
  const asgnIdx = indexOf(HEADERS.asgnId)
  const deviceIdx = indexOf(HEADERS.deviceSerial)
  const awbIdx = indexOf(HEADERS.awb)
  const courierIdx = indexOf(HEADERS.courierCode)

  // A missing REQUIRED column is a whole-file failure, never a per-row one: the
  // same policy the bank and device-inventory adapters apply. Every row would
  // fail identically, and reporting 99 identical row errors hides the one fact
  // the operator needs.
  //
  // `Device ID` stays in this list even though a blank VALUE is now legal. The
  // column and the value answer different questions: the column is part of the
  // sheet we send and getting it back tells us the vendor returned OUR workbook,
  // while a blank cell inside it is a deliberate report of collateral. Dropping
  // the column requirement would silently accept a sheet with no device column
  // at all and read every row as collateral.
  const missing = (
    [
      [asgnIdx, HEADERS.asgnId],
      [deviceIdx, HEADERS.deviceSerial],
      [awbIdx, HEADERS.awb],
    ] as const
  )
    .filter(([i]) => i < 0)
    // Name every accepted spelling, so the operator is told what WOULD work
    // rather than being left to guess which synonym we wanted.
    .map(([, names]) => names.map((n) => `"${n}"`).join(' or '))
  if (missing.length > 0) {
    return fail({ code: 'missing_column', message: `Missing required column(s): ${missing.join(', ')}.` })
  }

  const validRows: ReturnRow[] = []
  const invalidRows: ReturnSheetRowError[] = []
  grid.slice(1).forEach((cells, idx) => {
    const rowNo = idx + 1
    const asgnId = (cells[asgnIdx] ?? '').trim()
    const deviceSerial = (cells[deviceIdx] ?? '').trim()
    const awb = (cells[awbIdx] ?? '').trim()
    const courierCode = courierIdx >= 0 ? (cells[courierIdx] ?? '').trim() : ''

    const errors: ReturnSheetRowErrorCode[] = []
    if (asgnId === '') errors.push('missing_assignment')
    if (awb === '') errors.push('missing_awb')
    if (errors.length > 0) {
      invalidRows.push({ rowNo, errors })
      return
    }
    // No format rule on any of these values, deliberately, and for the same
    // reason A-2 is locked loose: we have not measured a real returned AWB, and
    // a rule invented for an unseen value rejects real files. Presence is the
    // bar until a real file says otherwise.
    //
    // A BLANK Device ID emits a row with NO deviceSerial KEY, never an empty
    // string. The ingest treats absent as "collateral-only consignment" and
    // present-but-empty as schema-invalid, which is the same distinction this
    // adapter has always drawn for a blank Courier cell, and it is what keeps a
    // future bug here from being read as a shipment nobody ordered.
    validRows.push({
      ...(deviceSerial === '' ? {} : { deviceSerial }),
      asgnId,
      awb,
      ...(courierCode === '' ? {} : { courierCode }),
    })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
