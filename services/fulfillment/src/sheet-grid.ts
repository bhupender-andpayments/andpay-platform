import ExcelJS from 'exceljs'

// The shared .csv / .xlsx grid reader for THIS CONTEXT's upload adapters.
//
// It was extracted from device-inventory-adapter.ts when the courier-status and
// activation uploads arrived (T5.1, T5.5, 13 Aug 2026) and would otherwise have
// been its second and third verbatim copy. The rule that produced those copies
// stands and is not being weakened: bank-file-adapter.ts documents this grid
// logic as a PER-CONTEXT PORT, deliberately not factored into a shared package,
// because a fulfillment-to-tms import would be a cross-context code dependency
// this repo does not allow (C4). That rule is about crossing CONTEXTS. All three
// callers here are fulfillment, so sharing costs nothing it was protecting, and
// three copies of a CSV tokenizer is how two of them quietly stop agreeing about
// quote escaping.
//
// Pure: no DB, no network, no filesystem writes, and it never logs cell content.

export type SheetGridErrorCode = 'unsupported_extension' | 'unreadable_file'

export interface SheetGridError {
  code: SheetGridErrorCode
  // Embeds the caller-supplied filename, so this string may never cross the
  // HTTP boundary (S4/5c). Adapters map it to their own error shape.
  message: string
}

export interface SheetGrid {
  header: string[]
  dataRows: string[][]
}

// Matching is NORMALIZED (case-folded, surrounding and repeated whitespace
// collapsed) because the same column is spelled "Sim No" in one document and
// "SIM No" by some senders, and a difference of case is never a meaningful
// distinction between two columns. An adapter that required a literal spelling
// once rejected a file that matched its own specification.
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Locate a canonical column in a parsed header. -1 when absent. */
export function headerIndexer(header: string[]): (name: string) => number {
  const normalized = header.map(normalizeHeader)
  return (name: string) => normalized.indexOf(normalizeHeader(name))
}

function detectFormat(filename: string): 'csv' | 'xlsx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  return null
}

// Minimal hand-rolled CSV tokenizer: the comma/newline-with-quote-escape grammar
// ported from apps/ops-portal/src/features/uploads/parseSheet.ts's parseCsv,
// kept as a port rather than a new dependency, matching that file's own
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

// Exported so workbook-sniff.ts can fall back to this SAME CSV reading path
// (rather than a second tokenizer) when a dropped file is not an xlsx: every
// dedicated adapter this sniffer routes to is CSV-capable, and a file the
// sniffer calls readable must stay one every adapter would also parse.
export function readCsvGrid(file: Uint8Array): string[][] {
  const text = new TextDecoder('utf-8').decode(file)
  return tokenizeCsv(text)
}

// Reads a worksheet into a plain string grid via ExcelJS's cell.text getter.
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

/**
 * Read one uploaded sheet into a header row plus data rows.
 *
 * Wholly blank rows are dropped (a trailing newline, or a trailing
 * formatted-but-empty xlsx row), neither of which carries data. A file that is
 * blank all the way through parses to an EMPTY header, which every caller must
 * treat as a missing-column failure rather than as an empty success.
 */
export async function parseSheetGrid(file: Uint8Array, filename: string): Promise<SheetGrid | SheetGridError> {
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
      // The duplicate-@types/node cast bank-file-adapter.ts documents at its
      // identical call site (exceljs's own dependency chain resolves a
      // different, older Buffer type than this file's Buffer.from; both are the
      // real Node Buffer class at runtime).
      await workbook.xlsx.load(Buffer.from(file) as unknown as Parameters<typeof workbook.xlsx.load>[0])
      grid = readXlsxGrid(workbook)
    }
  } catch {
    return { code: 'unreadable_file', message: `Failed to read "${filename}" as ${format.toUpperCase()}.` }
  }
  const nonBlank = grid.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonBlank.length === 0) return { header: [], dataRows: [] }
  return { header: nonBlank[0]!.map((h) => h.trim()), dataRows: nonBlank.slice(1) }
}
