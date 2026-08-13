import { parseSheetGrid, headerIndexer } from './sheet-grid.js'

// T5.5, D-19 (13 Aug 2026): the server-side parse for the CWD's ACTIVATION
// file, uploaded by ops.
//
// The walkthrough describes it as Device ID plus status per row, and both halves
// are load-bearing. The file names DEVICES, because that is what the CWD
// activates and what its own systems track; the platform activates ASSIGNMENTS,
// so the device serial has to be resolved back to the dispatch it was printed
// for. That resolution is not this module's job (it is a fulfillment read the
// edge composes with), but it is why Device ID is the required key here rather
// than a Dispatch ID nobody at the CWD holds.
//
// THE STATUS COLUMN IS READ AND ENFORCED, not ignored. Only a success can be
// recorded through this path: there is no failure write anywhere in the platform
// (the C3 fence, and activation_failure_reason has no writer), so a row claiming
// a failure cannot be honoured. It is REJECTED per row rather than skipped,
// because silently dropping a row the CWD reported on is how a device ends up
// with no recorded outcome at all and nobody notices.

const REQUIRED_HEADERS = { deviceId: 'Device ID', status: 'Status' } as const

// The tokens that mean "the CWD activated this". Spelled generously, because the
// file is written by another company's ops team and a difference of wording is
// never a meaningful distinction here. Anything else is refused by name.
const ACTIVATED_TOKENS = new Set(['ACTIVATED', 'ACTIVE', 'SUCCESS', 'SUCCESSFUL', 'DONE'])

export type ActivationFileStructuralErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface ActivationFileStructuralError {
  code: ActivationFileStructuralErrorCode
  // Embeds the caller-supplied filename for two of the three codes, so it may
  // never cross the HTTP boundary (S4/5c). `column` is server-controlled and may.
  message: string
  column?: string
}

export interface ActivationFileRow {
  rowNo: number
  deviceId: string
}

export type ActivationFileRowErrorCode = 'missing_device_id' | 'missing_status' | 'unsupported_status'

export interface ActivationFileRowError {
  rowNo: number
  errors: ActivationFileRowErrorCode[]
}

export interface ActivationFileParseResult {
  validRows: ActivationFileRow[]
  invalidRows: ActivationFileRowError[]
  structuralErrors: ActivationFileStructuralError[]
}

export async function parseActivationFile(file: Uint8Array, filename: string): Promise<ActivationFileParseResult> {
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
  // Before the zero-row check, so a headerless or wholly blank file is a
  // rejection rather than a silent empty success. A correct header with no rows
  // is a different, legitimate case.
  if (missing.length > 0) return { validRows: [], invalidRows: [], structuralErrors: missing }
  if (dataRows.length === 0) return { validRows: [], invalidRows: [], structuralErrors: [] }

  const deviceIdIdx = indexOfHeader(REQUIRED_HEADERS.deviceId)
  const statusIdx = indexOfHeader(REQUIRED_HEADERS.status)

  const validRows: ActivationFileRow[] = []
  const invalidRows: ActivationFileRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const deviceId = (cells[deviceIdIdx] ?? '').trim()
    const status = (cells[statusIdx] ?? '').trim().toUpperCase()

    const errors: ActivationFileRowErrorCode[] = []
    if (deviceId === '') errors.push('missing_device_id')
    if (status === '') errors.push('missing_status')
    else if (!ACTIVATED_TOKENS.has(status)) errors.push('unsupported_status')

    if (errors.length > 0) {
      invalidRows.push({ rowNo, errors })
      return
    }
    // The status is deliberately NOT carried forward. It has served its purpose
    // by the time a row is valid: every valid row means exactly one thing, and
    // passing a token downstream would invite a caller to branch on it and
    // reintroduce the failure path the C3 fence excludes.
    validRows.push({ rowNo, deviceId })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
