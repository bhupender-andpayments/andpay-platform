// Minimal client-side CSV reading, for the upload pages that act ROW BY ROW
// against existing per-record endpoints (courier statuses, CWD activations)
// rather than posting the file to a parser on the server.
//
// WHY CLIENT-SIDE AT ALL. Those two uploads are not new ingests: every row
// becomes one call to an endpoint that already exists and already authorizes
// per record (ops:status-correction, ops:mark-activated). Parsing on the
// server would mean a new route and a new permission for what is, on the
// wire, a loop. The trade is that these pages accept CSV only: an xlsx parser
// in the browser would drag ExcelJS into the bundle for two screens.
//
// The parser is the same hand-rolled one the vendor portal uses
// (apps/vendor-portal/src/features/returns/parseReturn.ts): double-quote
// handling, "" escapes, quoted fields may contain commas or newlines.

export function readFileAsText(file: File): Promise<string> {
  // FileReader rather than Blob.text(): jsdom implements only the former, so
  // the tests exercise the same path a real browser runs.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the file.'))
    reader.readAsText(file)
  })
}

export function parseCsv(text: string): string[][] {
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

/**
 * Header-mapped rows: the first non-blank row names the columns, every later
 * non-blank row becomes a record keyed by TRIMMED, case-insensitive header.
 * Returns null when a required header is absent, with the missing names, so
 * the page can say exactly which column the file lacks.
 */
export function csvRecords(
  text: string,
  required: readonly string[],
): { records: Record<string, string>[]; missing: string[] } {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''))
  if (grid.length === 0) return { records: [], missing: [...required] }
  const header = grid[0]!.map((h) => h.trim())
  const lower = header.map((h) => h.toLowerCase())
  const missing = required.filter((name) => !lower.includes(name.toLowerCase()))
  if (missing.length > 0) return { records: [], missing }
  const records = grid.slice(1).map((cells) => {
    const rec: Record<string, string> = {}
    header.forEach((h, idx) => {
      rec[h.toLowerCase()] = (cells[idx] ?? '').trim()
    })
    return rec
  })
  return { records, missing: [] }
}
