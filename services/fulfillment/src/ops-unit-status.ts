import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import { fromUuid } from '@andpay/ids'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'
import { parseUnitStatusFile } from './unit-status-adapter.js'
import { canAdvanceUnitStatus, advanceUnitStatus, type AnyUnitStatus } from './unit-lifecycle.js'
import { OpsClientError } from './ops.js'

// Bulk manual unit-status correction (2026-08-13 ruling): the sheet-upload half
// of the two options offered on the device page (edit one device by hand, or
// upload many at once). Same forward-only guard as the single-device edit
// (correctUnitStatus, ops.ts) and every automatic path: this is a new CALLER
// of canAdvanceUnitStatus/advanceUnitStatus, never a bypass. A device the sheet
// asks to move illegally is reported per-row and skipped, never fatal to the
// rest of the file - the same per-row-tolerant shape every upload in this
// codebase already follows.
const OPERATION = 'ops:upload-unit-status'

// A local copy, deliberately: ops-device-inventory.ts's own comment records
// why this fulfillment-context helper is not exported and shared even within
// this package (IDs/enums only, S7/S10.5, no PII, no row content). Mirrored
// here rather than imported.
function opsAllow(args: { principalId: string; resourceIds: string[]; traceId: string }): AuthzAuditRecord {
  return {
    principalId: args.principalId,
    cls: 3,
    actorChannel: 'human-direct',
    operation: OPERATION,
    decision: 'ALLOW',
    outcome: 'allowed',
    resourceIds: args.resourceIds,
    traceId: args.traceId,
  }
}

export interface UnitStatusPreviewRow {
  rowNo: number
  deviceId: string
  newStatus: string
  // null when the parser rejected the row before any DB lookup (missing/
  // malformed Device ID, unknown status spelling) or when no unit with this
  // serial exists.
  currentStatus: string | null
  legal: boolean
  errors: string[]
}

export interface OpsUnitStatusPreview {
  rows: UnitStatusPreviewRow[]
  totalRows: number
  willMove: number
  willReject: number
}

// PREVIEW: parse and compare against the CURRENT status of each named device,
// write NOTHING. Same posture as previewOpsDeviceInventory.
export async function previewOpsUnitStatus(
  db: FulfillmentDb,
  args: { fileBytes: Uint8Array; filename: string },
): Promise<OpsUnitStatusPreview> {
  const parsed = await parseUnitStatusFile(args.fileBytes, args.filename)
  if (parsed.structuralErrors.length > 0) {
    throw new OpsClientError(
      'invalid',
      'unit status file failed structural parse',
      parsed.structuralErrors.map((e) => (e.column === undefined ? { code: e.code } : { code: e.code, column: e.column })),
    )
  }

  const serials = parsed.validRows.map((r) => r.deviceId)
  const currentByserial = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    if (serials.length === 0) return new Map<string, string>()
    const rows = await tx.$queryRaw<{ device_serial: string; status: string }[]>`
      SELECT device_serial, status FROM unit WHERE device_serial = ANY(${serials})
    `
    return new Map(rows.map((r) => [r.device_serial, r.status]))
  })

  const rows: UnitStatusPreviewRow[] = []
  for (const r of parsed.validRows) {
    const currentStatus = currentByserial.get(r.deviceId) ?? null
    const legal = currentStatus !== null && canAdvanceUnitStatus(currentStatus, r.newStatus as AnyUnitStatus)
    rows.push({ rowNo: r.rowNo, deviceId: r.deviceId, newStatus: r.newStatus, currentStatus, legal, errors: [] })
  }
  for (const bad of parsed.invalidRows) {
    rows.push({ rowNo: bad.rowNo, deviceId: '', newStatus: '', currentStatus: null, legal: false, errors: [...bad.errors] })
  }
  rows.sort((a, b) => a.rowNo - b.rowNo)

  return {
    rows,
    totalRows: rows.length,
    willMove: rows.filter((r) => r.legal).length,
    willReject: rows.length - rows.filter((r) => r.legal).length,
  }
}

export interface UnitStatusResultRow {
  rowNo: number
  deviceId: string
  outcome: 'moved' | 'not_found' | 'illegal_transition' | 'invalid'
  errors: string[]
}

export interface OpsUnitStatusResult {
  fileId: string
  totalRows: number
  moved: number
  skipped: number
  rows: UnitStatusResultRow[]
  deduped: boolean
}

export async function ingestOpsUnitStatus(
  db: FulfillmentDb,
  args: { fileBytes: Uint8Array; filename: string; clientKey: string; actorId: string; traceId: string },
): Promise<OpsUnitStatusResult> {
  const parsed = await parseUnitStatusFile(args.fileBytes, args.filename)
  if (parsed.structuralErrors.length > 0) {
    throw new OpsClientError(
      'invalid',
      'unit status file failed structural parse',
      parsed.structuralErrors.map((e) => (e.column === undefined ? { code: e.code } : { code: e.code, column: e.column })),
    )
  }

  const rows: UnitStatusResultRow[] = []
  const movedUnitIds: string[] = []

  const ran = await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, OPERATION), async () => {
      for (const r of parsed.validRows) {
        const found = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id::text AS id, status FROM unit WHERE device_serial = ${r.deviceId}
        `
        if (found.length === 0) {
          rows.push({ rowNo: r.rowNo, deviceId: r.deviceId, outcome: 'not_found', errors: [] })
          continue
        }
        const { id, status: current } = found[0]!
        if (!canAdvanceUnitStatus(current, r.newStatus as AnyUnitStatus)) {
          rows.push({ rowNo: r.rowNo, deviceId: r.deviceId, outcome: 'illegal_transition', errors: [] })
          continue
        }
        const advanced = await advanceUnitStatus(tx, id, r.newStatus as AnyUnitStatus)
        if (advanced) {
          const unitWire = fromUuid('unit', id)
          movedUnitIds.push(unitWire)
          rows.push({ rowNo: r.rowNo, deviceId: r.deviceId, outcome: 'moved', errors: [] })
        } else {
          // A concurrent writer won the race between the SELECT above and this
          // UPDATE's own WHERE guard; the row-level guard (not this check) is
          // what actually prevents an illegal move, so this is reported the
          // same as any other rejected transition rather than trusted blind.
          rows.push({ rowNo: r.rowNo, deviceId: r.deviceId, outcome: 'illegal_transition', errors: [] })
        }
      }
      for (const bad of parsed.invalidRows) {
        rows.push({ rowNo: bad.rowNo, deviceId: '', outcome: 'invalid', errors: [...bad.errors] })
      }
      rows.sort((a, b) => a.rowNo - b.rowNo)

      // One file-level ALLOW (S15/T2), mirroring the device-inventory upload's
      // own posture: a bulk action has no single target resource, so this
      // carries every unit actually moved rather than an empty list, which is
      // more useful here than that precedent's blanket empty array.
      await enqueue(tx, buildAuthzAuditEvent(opsAllow({ principalId: args.actorId, resourceIds: movedUnitIds, traceId: args.traceId })))
    })
  })

  if (!ran) {
    return { fileId: args.clientKey, totalRows: 0, moved: 0, skipped: 0, rows: [], deduped: true }
  }
  return {
    fileId: args.clientKey,
    totalRows: rows.length,
    moved: rows.filter((r) => r.outcome === 'moved').length,
    skipped: rows.filter((r) => r.outcome !== 'moved').length,
    rows,
    deduped: false,
  }
}
