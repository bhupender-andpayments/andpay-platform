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

// One flagged (duplicate) row, by its ORIGINAL sheet row number, so the portal
// can say "row 7: this device is already added" instead of only a count. Codes
// are the intake_exception reason codes (duplicate_device_serial_in_file,
// duplicate_device_serial_existing_unit, duplicate_sim_no_in_file,
// duplicate_sim_no_existing_unit). No serial and no ICCID ride here.
export interface OpsDeviceInventoryFlaggedRow {
  rowNo: number
  errors: string[]
}

export interface OpsDeviceInventoryResult {
  fileId: string
  accepted: number
  flagged: number
  invalid: number
  createdUnitIds: string[]
  invalidRows: DeviceInventoryRowError[]
  flaggedRows: OpsDeviceInventoryFlaggedRow[]
  // How many of `invalid` were also queued into intake_exception for an
  // operator to correct (every one of them, when the commit ran; 0 on a
  // deduped replay). Distinct from `invalid` itself: that count describes what
  // never became a unit, this one describes what is now addressable in Queues.
  queuedForReview: number
  deduped: boolean
}

// One parsed row as the operator will see it BEFORE committing.
export interface DeviceInventoryPreviewRow {
  rowNo: number
  deviceId: string
  // The FULL value straight from the sheet, not masked: this is an internal
  // admin console and the operator's whole reason for opening the preview is
  // to cross-check it against the source Excel (2026-08-13 ruling, reversing
  // this same day's earlier masked-with-Reveal decision).
  simNo: string
  deviceQr: string
  /** Per-row format failures; a row carrying any of these is never ingested. */
  errors: string[]
  /** This Device ID is already a unit: committing will skip the row. */
  alreadyInStock: boolean
  /** This SIM is already on another unit: the device lands without a SIM. */
  simAlreadyUsed: boolean
  /** This Device ID repeats earlier in the same file. */
  duplicateInFile: boolean
}

export interface OpsDeviceInventoryPreview {
  rows: DeviceInventoryPreviewRow[]
  totalRows: number
  willAdd: number
  willFlag: number
  willReject: number
}

// PREVIEW: parse and compare, write NOTHING. Added 2026-08-13 because the
// upload had no preview at all - the operator picked a file and pressed a
// button, with no way to see what the sheet actually contained until after it
// had been ingested. A bank or damage file gets a preview; this one is the file
// most likely to be wrong (a manufacturer export nobody in the room produced),
// so it needed one most.
//
// Uses the SAME parser as the commit (parseDeviceInventoryFile), so what the
// preview reports and what the commit does cannot drift. It also answers the
// question a pure parse cannot: which rows collide with stock we already hold.
// That is a read-only SELECT over the serials/ICCIDs in THIS file, never a
// table scan.
//
// The preview is advisory, never authoritative: the commit re-parses and
// re-checks server-side (D-K), so a row that changes between the two is caught
// there, not trusted from here.
export async function previewOpsDeviceInventory(
  db: FulfillmentDb,
  args: { fileBytes: Uint8Array; filename: string },
): Promise<OpsDeviceInventoryPreview> {
  const parsed = await parseDeviceInventoryFile(args.fileBytes, args.filename)
  if (parsed.structuralErrors.length > 0) {
    throw new OpsClientError(
      'invalid',
      'device inventory file failed structural parse',
      parsed.structuralErrors.map((e) => (e.column === undefined ? { code: e.code } : { code: e.code, column: e.column })),
    )
  }

  const serials = parsed.validRows.map((r) => r.deviceId)
  const simNos = parsed.validRows.map((r) => r.simNo)

  // Read-only, and scoped to the values in this file. Empty arrays would make
  // `= ANY($1)` match nothing, which is the correct answer anyway, but the
  // queries are skipped so an empty sheet costs no round trip.
  const [existingSerials, existingSims] = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_ops_read')
    const s =
      serials.length === 0
        ? []
        : await tx.$queryRaw<{ device_serial: string }[]>`
            SELECT device_serial FROM unit WHERE device_serial = ANY(${serials})
          `
    const m =
      simNos.length === 0
        ? []
        : await tx.$queryRaw<{ sim_no: string }[]>`
            SELECT sim_no FROM unit WHERE sim_no = ANY(${simNos})
          `
    return [new Set(s.map((r) => r.device_serial)), new Set(m.map((r) => r.sim_no))] as const
  })

  const seenSerials = new Set<string>()
  // In-file ICCID parity with the commit path's seenSimNos (intake.ts): the
  // preview now drives whether Upload is even enabled (DeviceInventoryUploadPage,
  // 2026-08-13), so a gap here is no longer cosmetic - without it a file with
  // an in-file SIM repeat could preview clean and then still get flagged at
  // commit, and the two would disagree about what "clean" means.
  const seenSimNos = new Set<string>()
  const rows: DeviceInventoryPreviewRow[] = []

  for (const r of parsed.validRows) {
    const duplicateInFile = seenSerials.has(r.deviceId)
    seenSerials.add(r.deviceId)
    const simRepeatsInFile = seenSimNos.has(r.simNo)
    seenSimNos.add(r.simNo)
    rows.push({
      rowNo: r.rowNo,
      deviceId: r.deviceId,
      simNo: r.simNo,
      deviceQr: r.deviceQr,
      errors: [],
      alreadyInStock: existingSerials.has(r.deviceId),
      // Same consequence either way (the commit still creates the device,
      // just without a SIM), so an in-file repeat folds into the existing
      // flag rather than earning a new field.
      simAlreadyUsed: existingSims.has(r.simNo) || simRepeatsInFile,
      duplicateInFile,
    })
  }
  for (const bad of parsed.invalidRows) {
    rows.push({
      rowNo: bad.rowNo,
      deviceId: '',
      simNo: '',
      deviceQr: '',
      errors: [...bad.errors],
      alreadyInStock: false,
      simAlreadyUsed: false,
      duplicateInFile: false,
    })
  }
  rows.sort((a, b) => a.rowNo - b.rowNo)

  const willAdd = rows.filter((r) => r.errors.length === 0 && !r.alreadyInStock && !r.duplicateInFile).length
  const willFlag = rows.filter(
    (r) => r.errors.length === 0 && (r.alreadyInStock || r.duplicateInFile || r.simAlreadyUsed),
  ).length

  return {
    rows,
    totalRows: rows.length,
    willAdd,
    willFlag,
    willReject: parsed.invalidRows.length,
  }
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

  let result: { createdUnitIds: string[]; quarantined: number; flaggedRows: { rowRef: string; reason: string }[] } = {
    createdUnitIds: [],
    quarantined: 0,
    flaggedRows: [],
  }

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
      // persistDuplicateExceptions: false (2026-08-13 ruling, overturning R2 -
      // see docs/escalations/duplicate_rows_not_quarantined.md). A duplicate
      // still gets DETECTED and still counts toward `flagged` and
      // `flaggedRows` below, so the upload screen keeps naming exactly which
      // rows were skipped and why; it just never becomes an intake_exception
      // row, because there is nothing an operator can correct about a device
      // that is already in stock. Only the format-invalid loop below still
      // writes to intake_exception.
      result = await ingestIntakeSheetWithinTx(tx, sheet, args.traceId, {
        flagDuplicates: true,
        persistDuplicateExceptions: false,
      })

      // Format-invalid rows used to simply VANISH once the response was shown:
      // correctly never ingested (malformed data cannot become a unit), but
      // never RECORDED anywhere either, so an operator who navigated away lost
      // the chance to fix them (2026-08-13 review: "don't block it, give an
      // option to add it to quarantine"). They land in intake_exception so
      // Queues -> Intake exceptions is where every CORRECTABLE row from this
      // file ends up. Duplicates are deliberately NOT included here (same-day
      // follow-up ruling, above): intake_exception now holds only rows an
      // operator can actually act on. One exception row per (row, error
      // code): a row can fail more than one check at once (e.g. missing both
      // Device ID and SIM No).
      for (const bad of parsed.invalidRows) {
        for (const code of bad.errors) {
          await tx.$executeRaw`
            INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
            VALUES (gen_random_uuid(), ${manufacturerUuid}::uuid, ${args.clientKey}, ${`row-${bad.rowNo}`}, ${code})
          `
        }
      }

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
      // duplicate_sim_no_existing_unit reason is raised for the SAME row),
      // so row_accepted + row_flagged can exceed row_total minus row_invalid.
      // This is accurate to the domain, not a bug: do not "fix" these counts
      // to sum cleanly, and do not assume elsewhere that they do.
      //
      // row_flagged still counts every duplicate (it comes from
      // result.quarantined, which increments regardless of
      // persistDuplicateExceptions) - this ledger row is a record of what
      // HAPPENED to the file, not of what got written to intake_exception.
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

  // intake.ts flags a row as `row-${i}` where i indexes the sheet's rows
  // array, which was built 1:1 from parsed.validRows - so validRows[i].rowNo
  // recovers the ORIGINAL sheet row number the operator can find in the file.
  // Grouped by rowNo: today at most one reason is raised per row (serial
  // precedence, intake.ts), but the shape does not depend on that staying true.
  const flaggedByRow = new Map<number, string[]>()
  for (const f of result.flaggedRows) {
    const idx = Number(f.rowRef.replace('row-', ''))
    const rowNo = parsed.validRows[idx]?.rowNo
    if (rowNo === undefined) continue
    const list = flaggedByRow.get(rowNo) ?? []
    list.push(f.reason)
    flaggedByRow.set(rowNo, list)
  }
  const flaggedRows: OpsDeviceInventoryFlaggedRow[] = [...flaggedByRow.entries()]
    .map(([rowNo, errors]) => ({ rowNo, errors }))
    .sort((a, b) => a.rowNo - b.rowNo)

  return {
    fileId: args.clientKey,
    accepted: ran ? result.createdUnitIds.length : 0,
    flagged: ran ? result.quarantined : 0,
    invalid: ran ? parsed.invalidRows.length : 0,
    createdUnitIds: ran ? result.createdUnitIds : [],
    invalidRows: ran ? parsed.invalidRows : [],
    flaggedRows: ran ? flaggedRows : [],
    queuedForReview: ran ? parsed.invalidRows.length : 0,
    deduped: !ran,
  }
}
