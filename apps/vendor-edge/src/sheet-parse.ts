import type { IntakeRow, IntakeSheet, ReturnRow, ReturnSheet, StatusFile, StatusRow } from '@andpay/fulfillment-service'

// One typed parse error for every S8 schema-invalid body at the edge (a
// missing/extra/mistyped field): mapped to HTTP 400 by the caller, never
// echoing the raw untrusted input in the message.
export class EdgeParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EdgeParseError'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function assertOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new EdgeParseError(`${context}: unexpected field "${key}"`)
  }
}

// m1 defense-in-depth: a raw control byte (charCode < 0x20, which includes
// the 0x1e/0x1f bytes the 6e hash-chain canonicalization used to join on)
// can never enter an id/label field here, so it can never ride into an
// authz-audit record's resourceIds either. This is belt-and-suspenders on
// top of the chain's own injective JSON canonicalization (packages/audit/src/chain.ts):
// even if some other future caller joined fields with a delimiter again, an
// untrusted sheet could no longer smuggle that exact byte through the edge.
export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true
  }
  return false
}

function requireString(obj: Record<string, unknown>, field: string, context: string): string {
  const v = obj[field]
  if (typeof v !== 'string' || v.length === 0) throw new EdgeParseError(`${context}: missing or invalid "${field}"`)
  if (hasControlChar(v)) throw new EdgeParseError(`${context}: "${field}" contains a control character`)
  return v
}

// The webhook body is passed through to the handler's own per-courier mapper
// (status-webhook.ts's CourierPayloadMapper), which is the real schema gate
// for THAT shape (never duplicated here). This is only the S8 outer gate: a
// non-object body (a bare string, number, array, or null) is rejected before
// it ever reaches the mapper.
export function parseWebhookBody(json: unknown): unknown {
  if (!isPlainObject(json)) throw new EdgeParseError('webhook body must be a JSON object')
  return json
}

const INTAKE_SHEET_FIELDS = ['fileId', 'vndrId', 'workQueue', 'rows'] as const
// simNo (ICCID) is an OPTIONAL SERIALIZED field (only SIM-bearing devices carry
// it). Admitted here so the strict assertOnlyKeys whitelist no longer REJECTS a
// row that carries it. Sensitive-by-default downstream: stored, never emitted on
// a fact (S7) and not on any read surface, pending the architecture PII ruling.
const SERIALIZED_ROW_FIELDS = ['kind', 'deviceSerial', 'productType', 'deviceQr', 'simNo'] as const
const QUANTITY_LINE_ROW_FIELDS = ['kind', 'productType', 'count', 'qrString'] as const

function parseIntakeRow(row: unknown, index: number): IntakeRow {
  if (!isPlainObject(row)) throw new EdgeParseError(`intake sheet row ${String(index)}: must be an object`)
  const context = `intake sheet row ${String(index)}`
  if (row.kind === 'SERIALIZED') {
    assertOnlyKeys(row, SERIALIZED_ROW_FIELDS, context)
    const deviceSerial = requireString(row, 'deviceSerial', context)
    const productType = requireString(row, 'productType', context)
    if (!isPlainObject(row.deviceQr)) throw new EdgeParseError(`${context}: "deviceQr" must be an object`)
    // Optional: absent for non-SIM devices; when present, validated exactly like
    // any id/label field (non-empty string, no control byte, m1).
    const simNo = row.simNo === undefined ? undefined : requireString(row, 'simNo', context)
    return { kind: 'SERIALIZED', deviceSerial, productType, deviceQr: row.deviceQr, ...(simNo !== undefined ? { simNo } : {}) }
  }
  if (row.kind === 'QUANTITY_LINE') {
    assertOnlyKeys(row, QUANTITY_LINE_ROW_FIELDS, context)
    const productType = requireString(row, 'productType', context)
    const qrString = requireString(row, 'qrString', context)
    if (!Number.isInteger(row.count) || (row.count as number) <= 0) {
      throw new EdgeParseError(`${context}: "count" must be a positive integer`)
    }
    return { kind: 'QUANTITY_LINE', productType, count: row.count as number, qrString }
  }
  throw new EdgeParseError(`${context}: unknown "kind"`)
}

// Strict S8: a valid IntakeSheet body has EXACTLY these top-level fields and
// EXACTLY the fields each row's discriminated shape allows; anything missing,
// extra, or mistyped throws EdgeParseError (mapped to HTTP 400 by the caller).
export function parseIntakeSheet(json: unknown): IntakeSheet {
  if (!isPlainObject(json)) throw new EdgeParseError('intake sheet must be a JSON object')
  assertOnlyKeys(json, INTAKE_SHEET_FIELDS, 'intake sheet')
  const fileId = requireString(json, 'fileId', 'intake sheet')
  const vndrId = requireString(json, 'vndrId', 'intake sheet')
  const workQueue = requireString(json, 'workQueue', 'intake sheet')
  if (!Array.isArray(json.rows)) throw new EdgeParseError('intake sheet: "rows" must be an array')
  const rows = json.rows.map((row: unknown, index: number) => parseIntakeRow(row, index))
  return { fileId, vndrId, workQueue, rows }
}

const RETURN_SHEET_FIELDS = ['fileId', 'vndrId', 'workQueue', 'rows'] as const
const RETURN_ROW_FIELDS = ['deviceSerial', 'asgnId', 'awb', 'courierCode'] as const

function parseReturnRow(row: unknown, index: number): ReturnRow {
  if (!isPlainObject(row)) throw new EdgeParseError(`return sheet row ${String(index)}: must be an object`)
  const context = `return sheet row ${String(index)}`
  assertOnlyKeys(row, RETURN_ROW_FIELDS, context)
  // deviceSerial is handled EXACTLY like courierCode below: absent is allowed
  // (a row with a dispatch id and an AWB but no serial reports a collateral-only
  // consignment, since one dispatch id can travel under two AWBs), and when
  // present it must be a non-empty control-char-free string like any other id
  // field (m1). This edge checks SHAPE; the domain owns MEANING, so what an
  // absent serial MEANS is ingestReturnSheet's business, not this function's.
  const deviceSerial = row.deviceSerial === undefined ? undefined : requireString(row, 'deviceSerial', context)
  const asgnId = requireString(row, 'asgnId', context)
  const awb = requireString(row, 'awb', context)
  if (row.courierCode !== undefined && typeof row.courierCode !== 'string') {
    throw new EdgeParseError(`${context}: "courierCode" must be a string`)
  }
  return {
    ...(deviceSerial !== undefined ? { deviceSerial } : {}),
    asgnId,
    awb,
    ...(typeof row.courierCode === 'string' ? { courierCode: row.courierCode } : {}),
  }
}

// Strict S8, mirrors parseIntakeSheet's grammar for the return sheet's shape.
export function parseReturnSheet(json: unknown): ReturnSheet {
  if (!isPlainObject(json)) throw new EdgeParseError('return sheet must be a JSON object')
  assertOnlyKeys(json, RETURN_SHEET_FIELDS, 'return sheet')
  const fileId = requireString(json, 'fileId', 'return sheet')
  const vndrId = requireString(json, 'vndrId', 'return sheet')
  const workQueue = requireString(json, 'workQueue', 'return sheet')
  if (!Array.isArray(json.rows)) throw new EdgeParseError('return sheet: "rows" must be an array')
  const rows = json.rows.map((row: unknown, index: number) => parseReturnRow(row, index))
  return { fileId, vndrId, workQueue, rows }
}

const STATUS_FILE_FIELDS = ['fileId', 'vndrId', 'workQueue', 'rows'] as const
const STATUS_ROW_FIELDS = ['awb', 'status', 'courierTimestamp'] as const

function parseStatusRow(row: unknown, index: number): StatusRow {
  if (!isPlainObject(row)) throw new EdgeParseError(`status file row ${String(index)}: must be an object`)
  const context = `status file row ${String(index)}`
  assertOnlyKeys(row, STATUS_ROW_FIELDS, context)
  const awb = requireString(row, 'awb', context)
  const status = requireString(row, 'status', context)
  const courierTimestamp = requireString(row, 'courierTimestamp', context)
  return { awb, status, courierTimestamp }
}

// FR-06 BATCH_FILE mode. Strict S8, the same grammar as parseReturnSheet: the
// row VOCABULARY is deliberately not checked here (an unknown status is a
// per-row `unknown_status` QUARANTINE inland, not a whole-file rejection), and
// neither is the timestamp's parseability, which ingestStatusFile's own
// isStructurallyValid owns. The edge checks SHAPE; the domain owns MEANING.
export function parseStatusFile(json: unknown): StatusFile {
  if (!isPlainObject(json)) throw new EdgeParseError('status file must be a JSON object')
  assertOnlyKeys(json, STATUS_FILE_FIELDS, 'status file')
  const fileId = requireString(json, 'fileId', 'status file')
  const vndrId = requireString(json, 'vndrId', 'status file')
  const workQueue = requireString(json, 'workQueue', 'status file')
  if (!Array.isArray(json.rows)) throw new EdgeParseError('status file: "rows" must be an array')
  const rows = json.rows.map((row: unknown, index: number) => parseStatusRow(row, index))
  return { fileId, vndrId, workQueue, rows }
}
