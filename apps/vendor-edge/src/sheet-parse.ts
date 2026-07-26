import type { IntakeRow, IntakeSheet, ReturnRow, ReturnSheet } from '@andpay/fulfillment-service'

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

function requireString(obj: Record<string, unknown>, field: string, context: string): string {
  const v = obj[field]
  if (typeof v !== 'string' || v.length === 0) throw new EdgeParseError(`${context}: missing or invalid "${field}"`)
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
const SERIALIZED_ROW_FIELDS = ['kind', 'deviceSerial', 'productType', 'deviceQr'] as const
const QUANTITY_LINE_ROW_FIELDS = ['kind', 'productType', 'count', 'qrString'] as const

function parseIntakeRow(row: unknown, index: number): IntakeRow {
  if (!isPlainObject(row)) throw new EdgeParseError(`intake sheet row ${String(index)}: must be an object`)
  const context = `intake sheet row ${String(index)}`
  if (row.kind === 'SERIALIZED') {
    assertOnlyKeys(row, SERIALIZED_ROW_FIELDS, context)
    const deviceSerial = requireString(row, 'deviceSerial', context)
    const productType = requireString(row, 'productType', context)
    if (!isPlainObject(row.deviceQr)) throw new EdgeParseError(`${context}: "deviceQr" must be an object`)
    return { kind: 'SERIALIZED', deviceSerial, productType, deviceQr: row.deviceQr }
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
  const deviceSerial = requireString(row, 'deviceSerial', context)
  const asgnId = requireString(row, 'asgnId', context)
  const awb = requireString(row, 'awb', context)
  if (row.courierCode === undefined) return { deviceSerial, asgnId, awb }
  if (typeof row.courierCode !== 'string') throw new EdgeParseError(`${context}: "courierCode" must be a string`)
  return { deviceSerial, asgnId, awb, courierCode: row.courierCode }
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
