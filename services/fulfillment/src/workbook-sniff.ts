import ExcelJS from 'exceljs'
import { normalizeHeader, readCsvGrid } from './sheet-grid.js'
import { HEADERS as RETURN_HEADERS } from './return-sheet-adapter.js'
import { REQUIRED_HEADERS as COURIER_HEADERS } from './courier-status-adapter.js'
import { REQUIRED_HEADERS as ACTIVATION_HEADERS } from './activation-file-adapter.js'
import { HEADERS as UNIT_STATUS_HEADERS } from './unit-status-adapter.js'
import { REQUIRED_HEADERS as DEVICE_REQUIRED_HEADERS, OPTIONAL_HEADERS as DEVICE_OPTIONAL_HEADERS } from './device-inventory-adapter.js'

// The smart-upload sniffer (batch-first ops UX, Task 3): the operator drops one
// file (.csv or .xlsx, exactly the two formats every dedicated upload adapter
// already accepts) onto a single page, and this pure header match decides
// which of the dedicated upload pages it belongs on, BEFORE any of those
// pages' own parsers ever see it.
//
// WHY THIS CANNOT INVENT ITS OWN VOCABULARY. Each upload's own adapter is the
// only place its accepted column names are allowed to live; a second, hand-typed
// copy here is exactly the kind of thing that quietly stops agreeing with the
// adapter it is meant to describe (the same argument sheet-grid.ts already makes
// for the CSV tokenizer). So every header name below is IMPORTED from the
// adapter that actually enforces it, not retyped. `unit-status-adapter.ts`'s
// `HEADERS` happens to share the exact spelling (`Device ID` / `Status`) that
// `activation-file-adapter.ts`'s `REQUIRED_HEADERS` already exports, which is
// WHY the two are indistinguishable by header alone (see the activation/
// unit-status branch below): this sniffer states that collision rather than
// guessing past it.
//
// Bank detection is NOT here: `selectBankSourceProfile` (from
// `@andpay/tms-service`) is a cross-context call this fulfillment module is not
// allowed to make (C4), so the ops-edge route runs it itself, as the fallback
// once every fulfillment kind below has already come back empty.
//
// Pure: no DB, no network, no logging of header or file content (S4/5c).

export type SniffKind = 'return-sheet' | 'courier-status' | 'activation' | 'unit-status' | 'device-inventory' | 'bank'

/**
 * Match a parsed header row against every fulfillment upload's own required
 * columns. Order does not matter (comparison is a normalized set membership,
 * mirroring `headerIndexer`'s own case/whitespace folding), and a header that
 * satisfies more than one kind returns ALL of them: the activation file and the
 * unit-status file share the identical two-column shape (`Device ID`,
 * `Status`), so a caller must route the operator to a chooser rather than
 * guess between two files it cannot tell apart.
 */
export function sniffFulfillmentHeaders(headers: string[]): SniffKind[] {
  const set = new Set(headers.map((h) => normalizeHeader(h)))
  const has = (...names: string[]) => names.some((n) => set.has(normalizeHeader(n)))

  const kinds: SniffKind[] = []

  // return-sheet-adapter.ts: `Dispatch ID` (or its legacy `Assignment` synonym)
  // plus an AWB column names the print vendor's return workbook.
  if (has(...RETURN_HEADERS.asgnId) && has(...RETURN_HEADERS.awb)) {
    kinds.push('return-sheet')
  }

  // courier-status-adapter.ts: all three of its required columns, which is what
  // separates a courier's status file from the activation/unit-status pair
  // below (neither of those carries an AWB or a Status Date).
  if (has(COURIER_HEADERS.awb) && has(COURIER_HEADERS.status) && has(COURIER_HEADERS.statusDate)) {
    kinds.push('courier-status')
  }

  // activation-file-adapter.ts and unit-status-adapter.ts both require exactly
  // `Device ID` plus `Status`, and nothing else distinguishes their headers.
  // This is a DELIBERATE collision (see the module comment), not a bug to
  // resolve here: both candidates are returned, and the operator picks.
  if (
    has(ACTIVATION_HEADERS.deviceId, UNIT_STATUS_HEADERS.deviceId) &&
    has(ACTIVATION_HEADERS.status, UNIT_STATUS_HEADERS.newStatus) &&
    !has(COURIER_HEADERS.statusDate) &&
    !has(COURIER_HEADERS.awb)
  ) {
    kinds.push('activation', 'unit-status')
  }

  // device-inventory-adapter.ts: `Device ID` with no `Status` column (which
  // would instead read as the activation/unit-status pair above) and at least
  // one of its optional pass-through columns present, so a bare `Device ID`
  // alone (which matches nothing else either) is not claimed by this kind.
  if (
    has(DEVICE_REQUIRED_HEADERS.deviceId) &&
    !has(ACTIVATION_HEADERS.status, UNIT_STATUS_HEADERS.newStatus) &&
    has(DEVICE_OPTIONAL_HEADERS.simNo, DEVICE_OPTIONAL_HEADERS.deviceQr)
  ) {
    kinds.push('device-inventory')
  }

  return kinds
}

// Reads row 1 of an .xlsx workbook, or null when ExcelJS cannot load the bytes
// at all, or loads them but finds no worksheet, no rows, or a wholly blank
// first row (a BIFF8 .xls loaded under an .xlsx name lands here with zero
// worksheets rather than throwing, the same trap return-sheet-adapter.ts
// documents). Reuses the SAME ExcelJS load-then-read-row-1 path every xlsx
// adapter already uses (see e.g. `sheet-grid.ts`'s `readXlsxGrid`).
async function readXlsxHeader(bytes: Buffer): Promise<string[] | null> {
  let workbook: ExcelJS.Workbook
  try {
    workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch {
    return null
  }
  const ws = workbook.worksheets[0]
  if (!ws || ws.rowCount === 0) return null

  const headerRow = ws.getRow(1)
  const ncols = Math.max(headerRow.cellCount, headerRow.actualCellCount)
  const cells: string[] = []
  for (let c = 1; c <= ncols; c += 1) {
    cells.push((headerRow.getCell(c).text ?? '').trim())
  }
  if (cells.every((c) => c === '')) return null
  return cells
}

// Reads the first NON-BLANK row of a CSV as its header, or null when the file
// carries no non-blank row at all (empty, or whitespace/blank-lines only).
// Reuses sheet-grid.ts's OWN `readCsvGrid` tokenizer rather than a second CSV
// reader, and drops wholly-blank rows exactly as `parseSheetGrid` does, so a
// header this returns is one every CSV-capable adapter would also read as
// row 1.
function readCsvHeader(bytes: Buffer): string[] | null {
  const grid = readCsvGrid(bytes)
  const firstNonBlank = grid.find((row) => row.some((c) => c.trim() !== ''))
  if (!firstNonBlank) return null
  return firstNonBlank.map((c) => c.trim())
}

/**
 * Read the first (header) row of an uploaded workbook as plain strings, or
 * null when the bytes are not a readable file at all under EITHER format.
 *
 * Tries .xlsx first (via ExcelJS); when that load fails, or succeeds but
 * yields no worksheet, no rows, or a blank first row, falls back to the SAME
 * CSV reading path `sheet-grid.ts`'s adapters use. Every dedicated upload
 * this sniffer routes to (return sheet, courier status, activation, unit
 * status, device inventory) accepts BOTH .csv and .xlsx, so a file this
 * sniffer calls "readable" must stay one every one of those adapters would
 * also attempt to parse; an xlsx-only sniff would 400 a plain, valid CSV drop
 * that the dedicated page downstream would have accepted just fine.
 *
 * Never logs the bytes, the header cells, or a filename (there is none: this
 * function takes no filename, unlike the CSV-capable adapters, because format
 * here is decided by what the bytes actually parse as, not by an extension
 * string the client controls).
 */
export async function readWorkbookHeader(bytes: Buffer): Promise<string[] | null> {
  const xlsxHeader = await readXlsxHeader(bytes)
  if (xlsxHeader) return xlsxHeader
  return readCsvHeader(bytes)
}
