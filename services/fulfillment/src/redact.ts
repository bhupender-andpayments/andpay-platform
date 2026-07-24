// S7/S4: the pending-pool entry and the raw-device unit both carry PII-ish
// fields by design elsewhere in this context (the merchant snapshot, ship-to,
// QR/VPA value, device serial/QR). None of that may ever reach a log line.
// These are the two places a pool entry or a unit are projected for logging:
// ids, enums, and counts only, redacted before the first log line (5c).
export interface LoggablePoolEntry {
  asgnId: string
  tenantId: string
  programId: string
  poolStatus: string
  billable: boolean
  soundbox: boolean
}
export function redactPoolEntryForLog(e: {
  asgnId: string
  tenantId: string
  programId: string
  poolStatus: string
  billable: boolean
  soundbox: boolean
  merchantDisplayName?: string
  shipToAddress?: string
  qrValue?: string
  vpaValue?: string
}): LoggablePoolEntry {
  return {
    asgnId: e.asgnId,
    tenantId: e.tenantId,
    programId: e.programId,
    poolStatus: e.poolStatus,
    billable: e.billable,
    soundbox: e.soundbox,
  }
}
export interface LoggableUnit {
  unitId: string
  kind: string
  productType: string
  manufacturerVndr: string
  status: string
}
export function redactUnitForLog(u: {
  unitId: string
  kind: string
  productType: string
  manufacturerVndr: string
  status: string
  deviceSerial?: string
  deviceQr?: unknown
  qrString?: string
}): LoggableUnit {
  return {
    unitId: u.unitId,
    kind: u.kind,
    productType: u.productType,
    manufacturerVndr: u.manufacturerVndr,
    status: u.status,
  }
}
