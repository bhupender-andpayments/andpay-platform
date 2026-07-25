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
  // 06a/D116 additions (spec 08 outbound, Task 10): the recipient-contact
  // snapshot and the post-composition superseded-ship-to lock. Accepted here
  // (so a caller may pass the whole pending_pool_entry row through unchanged)
  // and dropped by the same omission as shipToAddress/qrValue/vpaValue above.
  shipToContactName?: string
  shipToMobile?: string
  supersededShipTo?: string
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

// The D116 ship-to amend fact (fct.tms.assignment.ship_to_amended.v1,
// ShipToAmendedFactView): the recipient PII it carries (address, contact
// name, mobile) never reaches a log line. Ids/enums only, allow-list style.
export interface LoggableShipToAmend {
  asgnId: string
  amendmentSeq: number
}
export function redactShipToAmendForLog(a: {
  asgnId: string
  amendmentSeq: number
  shipToAddress?: string
  contactName?: string
  mobile?: string
}): LoggableShipToAmend {
  return {
    asgnId: a.asgnId,
    amendmentSeq: a.amendmentSeq,
  }
}

// The per-adapter dispatch PACKAGE line (package.ts's PackageLine, D104): the
// entitled label content (display name, QR/VPA value) and the entitled ship
// view's recipient block are BOTH dropped here (S7). Even the print+ship
// adapter's own entitled label content never hits a log line: only the
// asgn_ id and the artifact object-store references are kept.
export interface LoggablePackageLine {
  asgnId: string
  artifactRefs: string[]
}
export function redactPackageLineForLog(line: {
  asgnId: string
  artifactRefs: string[]
  labelDisplayName: string
  labelQr: string
  shipToAddress?: string
  contactName?: string | null
  mobile?: string | null
}): LoggablePackageLine {
  return {
    asgnId: line.asgnId,
    artifactRefs: line.artifactRefs,
  }
}
