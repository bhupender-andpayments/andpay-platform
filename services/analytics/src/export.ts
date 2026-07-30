import type { ReportCell, ReportRow } from './mediation.js'

// Task 6: inline CSV export of an already-mediated ReportRow[] result. This is
// a pure serializer of data the mediation layer has already scoped and
// watermarked; it opens no connection and enters no scope of its own. No S3,
// no new transport, no port: the presigned-S3 transport is a deferred
// follow-up (per the ratified scope for this task).

// RFC 4180's own line terminator, used between records so a field's embedded
// '\n' (quoted per below) can never be confused with a record boundary.
const CRLF = '\r\n'

// The same 5 MiB-class discipline as the existing edges (see
// apps/vendor-edge/src/deps.ts MAX_SHEET_BYTES): bounded and fails closed
// rather than silently truncating or streaming without limit.
export const MAX_CSV_BYTES = 5 * 1024 * 1024

function needsQuoting(field: string): boolean {
  return field.includes(',') || field.includes('"') || field.includes('\n') || field.includes('\r')
}

// RFC 4180 field quoting: wrap in double quotes when the field contains a
// comma, a double quote, or a line break; double any embedded double quote.
function quoteField(field: string): string {
  if (!needsQuoting(field)) return field
  return `"${field.replace(/"/g, '""')}"`
}

function cellToString(cell: ReportCell): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'boolean') return cell ? 'true' : 'false'
  if (typeof cell === 'number') return String(cell)
  if (Array.isArray(cell)) return cell.join(';')
  return cell
}

/**
 * Serialize a mediated ReportRow[] result to CSV, RFC 4180 quoted. Columns are
 * the union of every row's keys, in first-seen order (the six reports each
 * have a fixed, uniform shape per call, so in practice this is just the first
 * row's keys). Throws rather than silently truncating when the serialized
 * size exceeds MAX_CSV_BYTES; the caller (an edge, in a later task) maps that
 * to the same bounded-response discipline the existing upload edges use.
 */
export function toCsv(rows: ReportRow[]): string {
  if (rows.length === 0) return ''

  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }

  const lines: string[] = [columns.map(quoteField).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => quoteField(cellToString(row[c] ?? null))).join(','))
  }

  const csv = lines.join(CRLF)
  const bytes = Buffer.byteLength(csv, 'utf8')
  if (bytes > MAX_CSV_BYTES) {
    throw new Error(
      `CSV export exceeds the 5 MiB inline-serialization bound (${bytes} bytes); the presigned-S3 transport is a deferred follow-up`,
    )
  }
  return csv
}
