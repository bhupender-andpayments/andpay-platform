import { parseSheetGrid, headerIndexer } from './sheet-grid.js'

// Phase 5 Task 1 (D-G, FR-01a): the SERVER-SIDE structural parse for the CWD
// device-inventory sheet (.csv or .xlsx). The grid reading itself moved to
// ./sheet-grid.ts on 13 Aug 2026, when the courier-status and activation
// uploads would otherwise have made it a second and third verbatim copy; see
// that file for why sharing WITHIN this context is not the cross-context import
// bank-file-adapter.ts rules out. What stays here is this sheet's own contract:
// its columns, its row rule, and its error vocabulary.
//
// Validation contract, RULED at the 12 Aug 2026 product walkthrough (Workflow
// A, FROZEN): the ONLY row validation is that Device ID is PRESENT. The
// duplicate check (a serial already in inventory, or repeated within the
// file) lives downstream in the shared ingest (intake.ts), which is the other
// half of the same ruling. Sim No and Device QR are OPTIONAL PASS-THROUGH
// columns: parsed and carried when present, empty strings when absent, and
// NEVER a reason to reject a row or a file. This supersedes FR-01a's
// all-three-mandatory reading and the 2026-08-09 format lock that used to
// live in this file (see the note above parseDeviceInventoryFile).
//
// A missing Device ID COLUMN in the header is still a whole-file structural
// failure (structuralErrors), the same policy the bank adapter applies: the
// walkthrough's rule speaks to row validation, and a file with no Device ID
// column cannot satisfy it for any row, so one structural error beats N
// identical row errors.

// Canonical column names follow BRD Annexure E exactly. Matching is normalized
// by sheet-grid.ts's headerIndexer, because the same column is spelled "Sim No"
// in the BRD and "SIM No" by some senders. This adapter previously required the
// literal "SIM No", so a file matching the BRD was rejected whole with zero rows
// ingested.
// Exported so workbook-sniff.ts can match on this file's OWN accepted column
// names rather than a hand-typed second copy that could drift from them.
export const REQUIRED_HEADERS = { deviceId: 'Device ID' } as const
export const OPTIONAL_HEADERS = { simNo: 'Sim No', deviceQr: 'Device QR' } as const

export type DeviceInventoryStructuralErrorCode = 'unsupported_extension' | 'unreadable_file' | 'missing_required_column'

export interface DeviceInventoryStructuralError {
  code: DeviceInventoryStructuralErrorCode
  message: string
  // The canonical column this failure is about, taken from HEADERS above and so
  // entirely server-controlled. It exists as its own field because `message`
  // embeds the caller-supplied filename for two of the three codes and
  // therefore may never cross the HTTP boundary (S4/5c, see OpsErrorFilter);
  // this field may.
  column?: string
}

export interface DeviceInventoryRow {
  rowNo: number
  deviceId: string
  simNo: string
  deviceQr: string
}

export type DeviceInventoryRowErrorCode = 'missing_device_id'

/**
 * SUPERSEDED FORMAT LOCK, kept as history so nobody re-tightens by reflex.
 *
 * This spot used to hold the A-2 / D12 format bands (a 10-to-20 digit Device
 * ID pattern and a charset-plus-length Sim No pattern), LOCKED BY BHUPENDER
 * 2026-08-09 with the instruction not to improve them without a real CWD file
 * and a decision. The 12 Aug 2026 product walkthrough is that decision, and
 * it went the OTHER way: Workflow A is FROZEN with Device ID presence as the
 * ONLY row validation, no format rule at all, because ingestion must bend to
 * whatever the partners actually send and the duplicate check downstream is
 * the real gate. So the patterns are GONE, not widened.
 *
 * What survives from the old note, because it is still true and still useful:
 *  - The device id is taken from the `Device ID` COLUMN, never parsed back
 *    out of the Device QR blob (whose `DI` key mirrors it per BRD Annexure E,
 *    and whose key spelling is unreliable, e.g. `" DOM"` with a leading
 *    space).
 *  - The only per-ROW error is a blank Device ID; a bad row is reported and
 *    skipped while the rest of the file still ingests. Only a missing Device
 *    ID COLUMN fails the whole file.
 *  - Any future tightening (format bands, the QR DI cross-check) needs a NEW
 *    ruling that supersedes the 12 Aug walkthrough; do not reintroduce it
 *    quietly here.
 */

export interface DeviceInventoryRowError {
  rowNo: number
  errors: DeviceInventoryRowErrorCode[]
}

export interface DeviceInventoryParseResult {
  validRows: DeviceInventoryRow[]
  invalidRows: DeviceInventoryRowError[]
  structuralErrors: DeviceInventoryStructuralError[]
}

// Parses one device-inventory file (.csv or .xlsx) into per-row Device ID/Sim
// No/Device QR strings. Per the 12 Aug 2026 walkthrough (Workflow A, FROZEN):
// a row is invalid ONLY when its Device ID is blank (reported by rowNo, NOT
// ingested, without failing the file); Sim No and Device QR are optional
// pass-through values, empty strings when their column or cell is absent. A
// missing Device ID COLUMN in the header is a whole-file structural failure
// (structuralErrors) - this check runs BEFORE the zero-data-row check (fix
// round 1, Finding A: it previously ran after, so a headerless or no-data
// file returned a silent empty success instead of a rejection; a wholly blank
// file parses to `header: []` from parseGrid, which also fails this check). A
// file with a CORRECT header but zero data rows is a DELIBERATE, DIFFERENT
// case (an operator uploads the template with no rows yet): it is a
// legitimate empty upload, not a client error, so it returns empty
// validRows/invalidRows with NO structural error and the caller processes it
// as a genuine 0-row upload.
export async function parseDeviceInventoryFile(file: Uint8Array, filename: string): Promise<DeviceInventoryParseResult> {
  const parsed = await parseSheetGrid(file, filename)
  if ('code' in parsed) return { validRows: [], invalidRows: [], structuralErrors: [parsed] }

  const { header, dataRows } = parsed

  // Both the presence check and the column lookup run on the SAME normalized
  // comparison, so a header that is accepted is always also locatable.
  const indexOfHeader = headerIndexer(header)

  const missing = (Object.keys(REQUIRED_HEADERS) as (keyof typeof REQUIRED_HEADERS)[])
    .filter((field) => indexOfHeader(REQUIRED_HEADERS[field]) === -1)
    .map((field) => ({
      code: 'missing_required_column' as const,
      message: `Missing required column "${REQUIRED_HEADERS[field]}".`,
      column: REQUIRED_HEADERS[field],
    }))
  if (missing.length > 0) return { validRows: [], invalidRows: [], structuralErrors: missing }

  if (dataRows.length === 0) return { validRows: [], invalidRows: [], structuralErrors: [] }

  const deviceIdIdx = indexOfHeader(REQUIRED_HEADERS.deviceId)
  // Optional columns: -1 when absent, and `cells[-1] ?? ''` reads as '', so an
  // absent column and a blank cell land on the same empty-string value.
  const simNoIdx = indexOfHeader(OPTIONAL_HEADERS.simNo)
  const deviceQrIdx = indexOfHeader(OPTIONAL_HEADERS.deviceQr)

  const validRows: DeviceInventoryRow[] = []
  const invalidRows: DeviceInventoryRowError[] = []
  dataRows.forEach((cells, idx) => {
    const rowNo = idx + 1
    const deviceId = (cells[deviceIdIdx] ?? '').trim()
    const simNo = (cells[simNoIdx] ?? '').trim()
    const deviceQr = (cells[deviceQrIdx] ?? '').trim()

    // The one row check the walkthrough grants. No format rule: see the
    // superseded-lock note above.
    if (deviceId === '') {
      invalidRows.push({ rowNo, errors: ['missing_device_id'] })
      return
    }
    validRows.push({ rowNo, deviceId, simNo, deviceQr })
  })

  return { validRows, invalidRows, structuralErrors: [] }
}
