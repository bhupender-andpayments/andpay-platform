import ExcelJS from 'exceljs'
import type { ReportCell, ReportRow } from './mediation.js'

// Task 6: inline CSV export of an already-mediated ReportRow[] result. This is
// a pure serializer of data the mediation layer has already scoped and
// watermarked; it opens no connection and enters no scope of its own. No S3,
// no new transport, no port: the presigned-S3 transport is a deferred
// follow-up (per the ratified scope for this task).

// RFC 4180's own line terminator, used between records so a field's embedded
// '\n' (quoted per below) can never be confused with a record boundary.
const CRLF = '\r\n'

// The same 5 MB-class discipline as the existing edges (see
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
      `CSV export exceeds the 5 MB inline-serialization bound (${bytes} bytes); the presigned-S3 transport is a deferred follow-up`,
    )
  }
  return csv
}

// ---------------------------------------------------------------------------
// The activation sheet (xlsx).
//
// toCsv above is GENERIC: it derives its columns from whatever keys the rows
// happen to carry, because it serves all six reports. This one is the opposite,
// and deliberately so. The activation sheet is a PRODUCT-RULED artifact sent to
// the CWD who does the activations, so its column set, its header wording and
// its grain are fixed here and cannot drift with a row shape. If a report row
// gains a column tomorrow, the CSV gains a column and this sheet does not.
//
// Like toCsv it is a PURE serializer of an already-mediated, already-scoped
// ReportRow[]: it opens no connection, enters no scope, and reads no id
// registry. Every value it writes was resolved server-side upstream.
// ---------------------------------------------------------------------------

// The seven columns, in the product-approved order and wording. `key` is the
// internal name the per-device addRow object uses; it is NOT a ReportRow key,
// because two of the cells (the device serial and its SIM) are per-INDEX values
// that no single row-level key can name.
const ACTIVATION_COLUMNS = [
  { header: 'Batch ID', key: 'batchId' },
  { header: 'Dispatch ID', key: 'dispatchId' },
  { header: 'Bank', key: 'bank' },
  { header: 'Merchant', key: 'merchant' },
  { header: 'Device ID', key: 'deviceId' },
  { header: 'SIM No', key: 'simNo' },
  { header: 'Delivered', key: 'delivered' },
]

// The 'not yet delivered' wording is product-owner approved and is deliberately
// a sentence, not a blank. A blank cell in a sheet that leaves the platform
// reads as a data gap the CWD should chase; this reads as the actual state of
// the dispatch, which is that there is nothing to activate yet.
const NOT_YET_DELIVERED = 'not yet delivered'

// Null, undefined and every non-string cell collapse to '' rather than to the
// string "null". Same contract as the writeRows helper in the fulfillment
// dispatch-package builder: a spreadsheet cell holding the four characters
// n-u-l-l is worse than an empty one, because a human reads it as data.
//
// That builder is named in prose, not by its path. The C4 guard in
// test/analytics_rail.test.ts scans this whole directory for the substring
// "services/<other context>/" and cannot tell a citation in a comment from a
// real import, deliberately, so that a genuine breach cannot dodge it by
// reformatting. Writing the path here would fail the build.
function textCell(cell: ReportCell | undefined): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string') return cell
  if (Array.isArray(cell)) return cell.join(';')
  return String(cell)
}

// A leading YYYY-MM-DD, which is exactly the prefix mediation's iso() emits
// (Date.toISOString(), always UTC).
const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})T/

/**
 * Render the Delivered cell.
 *
 * A present date is written as a plain calendar date, NOT the raw ISO
 * timestamp. The awaiting-activation worklist screen deliberately stopped
 * showing the wire format, and a sheet that is emailed to a party outside the
 * platform is the last place it should reappear: the recipient has no use for
 * a millisecond field or a Z suffix, and it invites them to read a UTC instant
 * as a local one.
 *
 * The date is taken by SLICING the ISO string's own date prefix rather than by
 * round-tripping through `new Date(...)`. Two reasons: the prefix is already
 * the UTC calendar day the mediation layer committed to, so slicing cannot
 * shift the day by a timezone; and a malformed value cannot make this throw
 * mid-workbook, it just falls through and is written verbatim.
 */
function deliveredCell(cell: ReportCell | undefined): string {
  if (cell === null || cell === undefined || cell === '') return NOT_YET_DELIVERED
  const text = textCell(cell)
  const match = ISO_DATE_PREFIX.exec(text)
  return match?.[1] ?? text
}

// Read one positional entry out of a ReportRow cell that should be a string[].
// A cell that is not an array at all (a report row that never carried it) is
// indistinguishable here from an array too short to reach `i`, and both must
// yield '' rather than a neighbour's value.
function atIndex(cell: ReportCell | undefined, i: number): string {
  if (!Array.isArray(cell)) return ''
  // noUncheckedIndexedAccess: an in-range read is still `string | undefined` to
  // the compiler, and here it genuinely can be out of range.
  return cell[i] ?? ''
}

/**
 * Serialize the awaiting-activation worklist into the single-sheet xlsx the CWD
 * works from.
 *
 * ONE ROW PER DEVICE, not one row per dispatch. The unit the CWD actually
 * activates is a device plus its SIM, so a merchant with two soundboxes owes
 * them two lines with the Dispatch ID repeated. Handing over one line carrying
 * two serials in a cell would make them split it by hand, which is where a
 * device-to-SIM mispairing gets introduced.
 *
 * `simNos` is POSITIONAL against `deviceIds` and is read by the same index. The
 * ops-edge merges it in from the fulfillment read (the SIM never reaches
 * analytics, S7) and documents that contract at
 * apps/ops-edge/src/reports.controller.ts, blanking a device whose SIM was
 * never captured rather than shifting its neighbours. This function honours the
 * same rule, because a shifted SIM would send the CWD to activate the wrong
 * subscriber against a device and nothing downstream could detect it.
 *
 * A row with no `deviceIds` contributes NO output rows: activation is of a
 * physical device, and a line with no serial is not work the CWD can do.
 *
 * Empty input yields a valid header-only workbook, never an error. Whether an
 * empty batch is a 404 is the caller's ruling, not the serializer's. The
 * caller's row order is preserved verbatim; there is no sort here.
 */
export async function activationSheetXlsx(rows: ReportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Activation')
  ws.columns = ACTIVATION_COLUMNS

  for (const row of rows) {
    const deviceIds = row['deviceIds']
    if (!Array.isArray(deviceIds)) continue
    // bankDisplay is the bank in words and is what the CWD reads; bankCode is
    // the fallback so a row whose display name never landed still names its
    // bank rather than leaving the column blank. An EMPTY display name falls
    // back too: it is the same missing-value case, differently shaped.
    const bankDisplay = textCell(row['bankDisplay'])
    const bank = bankDisplay === '' ? textCell(row['bankCode']) : bankDisplay
    const batchId = textCell(row['batchId'])
    const dispatchId = textCell(row['dispatchId'])
    const merchant = textCell(row['merchantDisplay'])
    const delivered = deliveredCell(row['deliveryDate'])
    const simNos = row['simNos']

    for (let i = 0; i < deviceIds.length; i++) {
      ws.addRow({
        batchId,
        dispatchId,
        bank,
        merchant,
        deviceId: atIndex(deviceIds, i),
        simNo: atIndex(simNos, i),
        delivered,
      })
    }
  }

  const arrayBuf = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuf)
}
