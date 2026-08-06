import { toUuid, InvalidIdError } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'
import { ingestIntakeSheetWithinTx, type IntakeSheet, type IntakeRow } from './intake.js'
import { parseDeviceInventoryFile, type DeviceInventoryRowError } from './device-inventory-adapter.js'
import { OpsClientError } from './ops.js'

// Phase 5 Task 1 (D-G, FR-01a): the class-3 ops device-inventory upload, the
// ops analog of the vendor-channel manufacturer intake (intake.ts). Reuses
// ingestIntakeSheetWithinTx (flagDuplicates:true) for the SAME dedup (repeat
// serial / duplicate ICCID, in-file AND against an existing unit) and Unit
// insert the vendor channel runs; this adds NO new dedup logic and NO new
// device state machine (units enter at IN_STOCK, per the ratified brief; the
// rejected plan-text "warehouse->assigned->printed->live" state machine does
// not exist here).
//
// manufacturerVndrId is a RATIFIED VALIDATED BODY REFERENCE: a class-3
// all-programs ops principal carries no vendor scope of its own to pin
// against (unlike the class-6 vendor-channel claim, whose scope.vndr IS the
// sheet's vndrId), so the request carries the target manufacturer vndr and
// this function validates it server-side (a SELECT, never trusted blind)
// BEFORE any write. This is a validated DATA ATTRIBUTE, not a principal
// scope, so it is NOT an M7/S16 violation for this principal.
const OPERATION = 'ops:upload-device-inventory'
const WORK_QUEUE = 'ops-device-inventory'
// FR-01a's device-inventory sheet carries no productType column (Device ID,
// SIM No, Device QR only). In this domain a "device" (a SERIALIZED,
// uniquely-numbered unit) is always a Soundbox: standee/sticker are printed
// collateral tracked as QUANTITY_LINE, never individually serialized (see
// the unit.product_type schema comment and intake.test.ts's own
// serializedRow default). SOUNDBOX is therefore the only productType this
// upload ever sets.
const DEVICE_PRODUCT_TYPE = 'SOUNDBOX'

// The co-committed ALLOW 6e record (S15/T2 ruling), the fulfillment-context
// twin of ops.ts's own local opsAllow (each context keeps its own copy,
// matching the existing fulfillment/tms precedent rather than exporting a
// shared one). IDs/enums only (S7/S10.5): no PII, no row content.
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

export interface OpsDeviceInventoryResult {
  fileId: string
  accepted: number
  flagged: number
  invalid: number
  createdUnitIds: string[]
  invalidRows: DeviceInventoryRowError[]
  deduped: boolean
}

export async function ingestOpsDeviceInventory(
  db: FulfillmentDb,
  args: {
    fileBytes: Uint8Array
    filename: string
    manufacturerVndrId: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<OpsDeviceInventoryResult> {
  // Fix round 1, Finding B: manufacturerVndrId is caller-supplied (a class-3
  // ops principal's request body), so a malformed value must NOT crash out
  // as an uncaught InvalidIdError (a 500). Decode it defensively BEFORE the
  // file parse and map a bad id to the SAME OpsClientError('invalid', ...)
  // client-error shape every other bad-input path here already uses (the
  // app-wide OpsErrorFilter maps it to a 400).
  let manufacturerUuid: string
  try {
    manufacturerUuid = toUuid(args.manufacturerVndrId)
  } catch (err) {
    if (err instanceof InvalidIdError) {
      throw new OpsClientError('invalid', 'manufacturerVndrId is not a valid id')
    }
    throw err
  }

  // Server-side parse BEFORE any transaction opens (never trust client rows;
  // mirrors ingestIntakeSheet's STEP B ordering). A structural failure (bad
  // extension, unreadable bytes, a missing required column) rejects the
  // WHOLE file: no manufacturer validation, no write, no burned clientKey.
  const parsed = await parseDeviceInventoryFile(args.fileBytes, args.filename)
  if (parsed.structuralErrors.length > 0) {
    // Carry the CODE (a closed server-owned enum) and, for a missing column,
    // its canonical name. The adapter's `message` is deliberately NOT passed:
    // it embeds args.filename for the extension/unreadable codes, and a
    // caller-supplied filename must never ride an HTTP response (S4/5c).
    // Without this the operator saw only "invalid request" and could not tell
    // which column was wrong, which is the failure that cost us this step.
    throw new OpsClientError(
      'invalid',
      'device inventory file failed structural parse',
      parsed.structuralErrors.map((e) => (e.column === undefined ? { code: e.code } : { code: e.code, column: e.column })),
    )
  }

  const rows: IntakeRow[] = parsed.validRows.map((r) => ({
    kind: 'SERIALIZED',
    deviceSerial: r.deviceId,
    productType: DEVICE_PRODUCT_TYPE,
    // The sheet's raw "Device QR" cell is a plain string; intake.ts's
    // SerializedIntakeRow.deviceQr must be a non-null, non-array object (see
    // isStructurallyValid), and no downstream reader assumes any particular
    // internal shape for device_qr (it is opaque, sensitive-by-default
    // storage, never emitted on a fact or any read surface). Wrapping the
    // raw value under a single `raw` key satisfies the object shape without
    // inventing any unratified internal schema.
    deviceQr: { raw: r.deviceQr },
    simNo: r.simNo,
  }))

  let result: { createdUnitIds: string[]; quarantined: number } = { createdUnitIds: [], quarantined: 0 }

  const ran = await db.$transaction(async (tx: Tx) => {
    // Validate the manufacturer reference SERVER-SIDE (ratified: a data
    // attribute, not a principal scope) BEFORE entering the write role, the
    // same ordering ops.ts's holdRecord/resolveProgramAndAwb already use for
    // a target lookup that precedes enterWriteScope/enterWriteRole.
    const vndrRows = await tx.$queryRaw<{ type: string }[]>`
      SELECT type FROM vndr WHERE id = ${manufacturerUuid}::uuid
    `
    if (vndrRows.length === 0) throw new OpsClientError('not-found', 'manufacturerVndrId not found')
    if (vndrRows[0]!.type !== 'MANUFACTURER') {
      throw new OpsClientError('invalid', 'manufacturerVndrId does not reference a MANUFACTURER vendor')
    }

    // Landmine order (role -> onceWithin -> effect + enqueue).
    await enterWriteRole(tx, 'fulfillment_write')

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, OPERATION), async () => {
      const sheet: IntakeSheet = {
        // fileId = clientKey: stable across a retry of the same
        // Idempotency-Key, so ingestIntakeSheetWithinTx's OWN
        // {vndrId}|{fileId} inbox key is stable too (mirrors
        // commitBankFile's server-owned fileId rule).
        fileId: args.clientKey,
        vndrId: args.manufacturerVndrId,
        workQueue: WORK_QUEUE,
        rows,
      }
      result = await ingestIntakeSheetWithinTx(tx, sheet, args.traceId, { flagDuplicates: true })

      const rowTotal = parsed.validRows.length + parsed.invalidRows.length
      // The upload-audit ledger row (R5, FR-01a V2): distinct from the 6e
      // authz audit enqueued below. One row per upload attempt, carrying the
      // uploader and the row counts (total/accepted/flagged/invalid).
      // actorId is ALREADY a raw uuid string (the resolved class-3 principal
      // id off the verified claim, req.claim.sub at the edge), never a
      // wire-form andpay id, matching every other actor column in this
      // context (held_by_actor, released_by_actor, resolved_by_actor,
      // triggered_by_actor all cast the raw actor id directly, no toUuid).
      //
      // Fix round 1, Finding C: row_accepted and row_flagged are NOT a
      // partition of row_total. A row can be BOTH created and flagged (the
      // duplicate-ICCID-vs-existing-unit case, Confirm 3 in intake.ts: the
      // conflicting device is still created with sim_no null AND a
      // duplicate_sim_no_existing_unit intake_exception is raised for the
      // SAME row), so row_accepted + row_flagged can exceed row_total minus
      // row_invalid. This is accurate to the domain, not a bug: do not
      // "fix" these counts to sum cleanly, and do not assume elsewhere that
      // they do.
      await tx.$executeRaw`
        INSERT INTO device_inventory_upload
          (id, file_id, uploader, manufacturer_vndr, row_total, row_accepted, row_flagged, row_invalid, status, created_at)
        VALUES
          (gen_random_uuid(), ${args.clientKey}, ${args.actorId}::uuid, ${manufacturerUuid}::uuid,
           ${rowTotal}, ${result.createdUnitIds.length}, ${result.quarantined}, ${parsed.invalidRows.length}, ${'processed'}, now())
      `

      // Co-commit the ALLOW 6e (S15/T2 ruling) in the SAME tx as the ledger
      // row and the intake effect. IDs/enums only (S7/S10.5): no PII, no row
      // content rides this record. A file-level upload has no single target
      // resource, so resourceIds is empty (mirrors commitBankFile).
      await enqueue(tx, buildAuthzAuditEvent(opsAllow({ principalId: args.actorId, resourceIds: [], traceId: args.traceId })))
    })
  })

  return {
    fileId: args.clientKey,
    accepted: ran ? result.createdUnitIds.length : 0,
    flagged: ran ? result.quarantined : 0,
    invalid: ran ? parsed.invalidRows.length : 0,
    createdUnitIds: ran ? result.createdUnitIds : [],
    invalidRows: ran ? parsed.invalidRows : [],
    deduped: !ran,
  }
}
