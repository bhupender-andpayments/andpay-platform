// Client-side parse of the FR-05 return-sheet CSV into the exact ReturnSheet
// JSON shape `parseReturnSheet` (apps/vendor-edge/src/sheet-parse.ts) accepts:
// `{ fileId, vndrId, workQueue, rows }` with each row EXACTLY
// `{ deviceSerial, asgnId, awb, courierCode? }` (assertOnlyKeys, no extras).
// This is presentation-only parsing (D117-style): the edge is the real
// schema/authz gate (S8), this client only maps CSV columns to field names.

export interface ReturnRow {
  deviceSerial: string
  asgnId: string
  awb: string
  courierCode?: string
}

export interface ReturnSheet {
  fileId: string
  vndrId: string
  workQueue: string
  rows: ReturnRow[]
}

export class ReturnParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReturnParseError'
  }
}

// The client-side 5 MiB upload cap, checked against File.size BEFORE any
// read/parse/POST, so an oversized file never touches the network. Mirrors
// the edge's own MAX_SHEET_BYTES (apps/vendor-edge/src/deps.ts) so a file
// that would be rejected server-side is rejected here first.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

// jsdom's Blob/File implementation does not implement
// Blob.text()/arrayBuffer(), only FileReader, so this reads via FileReader
// for portability across jsdom and real browsers alike (mirrors
// apps/ops-portal/src/features/uploads/parseSheet.ts).
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the file.'))
    reader.readAsText(file)
  })
}

// Minimal hand-rolled CSV parser (no dependency): a comma/newline split with
// double-quote handling ("" escapes a literal quote, a quoted field may
// contain commas or newlines).
function parseCsv(text: string): string[][] {
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

// FR-05 column map: Dispatch ID -> asgnId, Device ID -> deviceSerial,
// AWB -> awb, Courier Partner -> courierCode (optional). "Dispatch Date" is
// NOT a ReturnRow field (the shpt dispatch date is server-side) and is
// deliberately never read here.
const DISPATCH_ID_HEADER = 'Dispatch ID'
const DEVICE_ID_HEADER = 'Device ID'
const AWB_HEADER = 'AWB'
const COURIER_PARTNER_HEADER = 'Courier Partner'
const REQUIRED_HEADERS = [DISPATCH_ID_HEADER, DEVICE_ID_HEADER, AWB_HEADER] as const

// Parses the FR-05 return-sheet CSV into the full ReturnSheet the edge
// expects. `vndrId` MUST be the operator's own token vndr (never
// caller-supplied) and `fileId` MUST be stable per parsed file (generated
// ONCE at parse time by the caller and reused across a retry, so a retry
// re-POSTs the same `${vndrId}|${fileId}` inbox key and dedups to a no-op).
// `workQueue` is sent as the constant 'vendor-portal': it is a required
// non-empty string on the wire, but authz-VESTIGIAL for class 7
// (authorizeVendor runs with enforceWorkQueue:false and ingestReturnSheet
// does not otherwise consume it).
export function parseReturnCsv(text: string, vndrId: string, fileId: string): ReturnSheet {
  const rawRows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''))
  if (rawRows.length === 0) throw new ReturnParseError('The file is empty.')

  const header = rawRows[0]!.map((h) => h.trim())
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new ReturnParseError(`The file is missing the required column "${required}".`)
    }
  }

  const dispatchIdx = header.indexOf(DISPATCH_ID_HEADER)
  const deviceIdx = header.indexOf(DEVICE_ID_HEADER)
  const awbIdx = header.indexOf(AWB_HEADER)
  const courierIdx = header.indexOf(COURIER_PARTNER_HEADER)

  const dataRows = rawRows.slice(1)
  const rows: ReturnRow[] = dataRows.map((r, idx) => {
    const deviceSerial = (r[deviceIdx] ?? '').trim()
    const asgnId = (r[dispatchIdx] ?? '').trim()
    const awb = (r[awbIdx] ?? '').trim()
    if (deviceSerial === '' || asgnId === '' || awb === '') {
      throw new ReturnParseError(`Row ${String(idx + 1)} is missing a required value (Device ID, Dispatch ID, or AWB).`)
    }
    const courierCode = courierIdx >= 0 ? (r[courierIdx] ?? '').trim() : ''
    return courierCode === '' ? { deviceSerial, asgnId, awb } : { deviceSerial, asgnId, awb, courierCode }
  })

  return { fileId, vndrId, workQueue: 'vendor-portal', rows }
}
