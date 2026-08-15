import { parseSheetGrid, headerIndexer } from './sheet-grid.js'

// T5.1, D-17 (13 Aug 2026): the server-side parse for the COURIER'S MORNING
// STATUS FILE, uploaded by ops.
//
// D-17's Phase-1 story is a courier emailing a spreadsheet and an operator
// uploading it. The platform already had a batch status path, but it was JSON
// on a vendor-credentialed route, which serves an integrated courier and cannot
// serve an emailed file: there is no courier session behind an inbox. So this
// adapter turns the sheet into the same rows that route already carries, and the
// ingest below them is shared rather than duplicated.
//
// THREE COLUMNS, all required, because unlike the device-inventory sheet there
// is no useful partial row here: a status update with no AWB names nothing, one
// with no status says nothing, and one with no timestamp cannot be ordered
// against the updates around it. Absent columns fail the FILE; blank or
// unparseable cells fail their ROW.

const REQUIRED_HEADERS = { awb: 'AWB', status: 'Status', statusDate: 'Status Date' } as const

export type CourierStatusStructuralErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface CourierStatusStructuralError {
  code: CourierStatusStructuralErrorCode
  // Embeds the caller-supplied filename for two of the three codes, so it may
  // never cross the HTTP boundary (S4/5c). `column` is server-controlled and may.
  message: string
  column?: string
}

export interface CourierStatusFileRow {
  rowNo: number
  awb: string
  status: string
  courierTimestamp: string // ISO 8601
}

export type CourierStatusRowErrorCode = 'missing_awb' | 'missing_status' | 'missing_status_date' | 'unparseable_status_date'

export interface CourierStatusRowError {
  rowNo: number
  errors: CourierStatusRowErrorCode[]
}

export interface CourierStatusParseResult {
  validRows: CourierStatusFileRow[]
  invalidRows: CourierStatusRowError[]
  structuralErrors: CourierStatusStructuralError[]
}

// Couriers date their files in whatever their ops team uses, so this accepts a
// plain ISO instant and the two unambiguous forms a spreadsheet commonly
// produces, and refuses everything else rather than guessing.
//
// DD/MM/YYYY IS NOT ACCEPTED, deliberately, and neither is MM/DD/YYYY: they are
// indistinguishable for the first twelve days of every month, and a status
// silently dated five weeks wrong is worse than a rejected row an operator can
// see and fix. The status VOCABULARY is not checked here either; that belongs to
// the ingest, which quarantines an unknown token per row exactly as the vendor
// route does.
function parseCourierTimestamp(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null
  // A bare YYYY-MM-DD is read as UTC midnight rather than local, so the same
  // file parsed on two machines produces the same instant.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
    const d = new Date(value.replace(' ', 'T'))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

export async function parseCourierStatusFile(
  file: Uint8Array,
  filename: string,
): Promise<CourierStatusParseResult> {
  const parsed = await parseSheetGrid(file, filename)
  if ('code' in parsed) return { validRows: [], invalidRows: [], structuralErrors: [parsed] }

  const { header, dataRows } = parsed
  const indexOfHeader = headerIndexer(header)

  const missing = (Object.keys(REQUIRED_HEADERS) as (keyof typeof REQUIRED_HEADERS)[])
    .filter((field) => indexOfHeader(REQUIRED_HEADERS[field]) === -1)
    .map((field) => ({
      code: 'missing_required_column' as const,
      message: `Missing required column "${REQUIRED_HEADERS[field]}".`,
      column: REQUIRED_HEADERS[field],
    }))
  // Reported BEFORE the zero-row check, so a headerless or wholly blank file is
  // a rejection rather than a silent empty success. A file with a CORRECT header
  // and no rows is a different, legitimate case: a courier with nothing to
  // report that morning.
  if (missing.length > 0) return { validRows: [], invalidRows: [], structuralErrors: missing }
  if (dataRows.length === 0) return { validRows: [], invalidRows: [], structuralErrors: [] }

  const awbIdx = indexOfHeader(REQUIRED_HEADERS.awb)
  const statusIdx = indexOfHeader(REQUIRED_HEADERS.status)
  const dateIdx = indexOfHeader(REQUIRED_HEADERS.statusDate)

  const validRows: CourierStatusFileRow[] = []
  const invalidRows: CourierStatusRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const awb = (cells[awbIdx] ?? '').trim()
    // A courier's own export writes "In Transit"; the ladder speaks
    // IN_TRANSIT. Whitespace-to-underscore is spelling, not meaning, so it is
    // normalized here exactly as case already is (16 Aug 2026 UAT walkthrough,
    // finding B8: a human-styled status was held as unknown). An actually
    // unknown status still lands in the exceptions queue downstream.
    const status = (cells[statusIdx] ?? '').trim().toUpperCase().replace(/\s+/g, '_')
    const rawDate = (cells[dateIdx] ?? '').trim()

    // EVERY failing check on a row is reported, not just the first. An operator
    // fixing a file one error at a time re-uploads once per column.
    const errors: CourierStatusRowErrorCode[] = []
    if (awb === '') errors.push('missing_awb')
    if (status === '') errors.push('missing_status')
    const iso = rawDate === '' ? null : parseCourierTimestamp(rawDate)
    if (rawDate === '') errors.push('missing_status_date')
    else if (iso === null) errors.push('unparseable_status_date')

    if (errors.length > 0) {
      invalidRows.push({ rowNo, errors })
      return
    }
    validRows.push({ rowNo, awb, status, courierTimestamp: iso! })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
