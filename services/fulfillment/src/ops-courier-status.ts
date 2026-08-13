import { toUuid, InvalidIdError } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { buildAuthzAuditEvent, type AuthzAuditRecord } from '@andpay/audit'
import { instanceKey } from '@andpay/keys'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'
import { ingestStatusRowsWithinTx } from './status-file.js'
import { parseCourierStatusFile, type CourierStatusRowError } from './courier-status-adapter.js'
import { OpsClientError } from './ops.js'

// D-17 (T5.1, 13 Aug 2026): the OPS door onto the courier-status rail.
//
// The platform already had a batch status path, and it could not serve the story
// D-17 actually describes. That path is JSON on a vendor-credentialed route,
// which is right for an integrated courier posting from its own systems and
// useless for the Phase-1 reality: a courier emails a spreadsheet every morning
// and an operator has to get it into the platform. There is no courier session
// behind an inbox.
//
// So this is a second sanctioned door, built the way TA.4 recorded the vendor
// intake door: the AUTHORIZATION differs and nothing else does. The row loop is
// literally shared code (ingestStatusRowsWithinTx), so the same status
// vocabulary, the same per-row courier-ownership rule, the same quarantine
// reasons and the same advanceShipmentStatus apply whichever door an update came
// through. A second copy would drift, and the drift would only show up as a
// parcel taking a different path depending on how its update arrived.
//
// The COURIER IS NAMED BY THE OPERATOR, and that is a validated data attribute
// rather than a principal scope, exactly like manufacturerVndrId on the
// device-inventory upload: a class-3 all-programs ops principal carries no
// vendor scope to pin against. It is checked server-side against the vendor
// master before any write, and naming the wrong courier quarantines every row as
// wrong_courier rather than moving somebody else's parcels (M7/S16 is not
// weakened: the operator cannot assert a scope, only a target).
const OPERATION = 'ops:upload-courier-status'

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

export interface OpsCourierStatusResult {
  fileId: string
  /** Rows that moved a shipment forward on the ladder. */
  advanced: number
  /** Rows recorded on the trail without advancing (an out-of-order or repeat status). */
  trailOnly: number
  /** Rows the platform could not apply, held in courier_status_exception. */
  quarantined: number
  /** Rows the FILE itself was wrong about (blank AWB, unparseable date). Never reach the rail. */
  invalid: number
  invalidRows: CourierStatusRowError[]
  deduped: boolean
}

export async function ingestOpsCourierStatus(
  db: FulfillmentDb,
  args: {
    fileBytes: Uint8Array
    filename: string
    courierVndrId: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<OpsCourierStatusResult> {
  // A malformed id is a client error, not a 500: decode defensively before
  // anything else, the same posture as the device-inventory upload.
  let courierUuid: string
  try {
    courierUuid = toUuid(args.courierVndrId)
  } catch (err) {
    if (err instanceof InvalidIdError) throw new OpsClientError('invalid', 'courierVndrId is not a valid id')
    throw err
  }

  // Server-side parse BEFORE any transaction opens (never trust client rows). A
  // structural failure rejects the WHOLE file: no write, no burned clientKey.
  const parsed = await parseCourierStatusFile(args.fileBytes, args.filename)
  if (parsed.structuralErrors.length > 0) {
    // The CODE and, for a missing column, its canonical name. The adapter's
    // `message` embeds the caller-supplied filename and must never ride an HTTP
    // response (S4/5c).
    throw new OpsClientError(
      'invalid',
      'courier status file failed structural parse',
      parsed.structuralErrors.map((e) => (e.column === undefined ? { code: e.code } : { code: e.code, column: e.column })),
    )
  }

  let counts = { advanced: 0, trailOnly: 0, quarantined: 0 }

  const ran = await db.$transaction(async (tx: Tx) => {
    // Validate the courier reference server-side before entering the write role,
    // the same ordering the device-inventory upload uses for its manufacturer.
    const vndrRows = await tx.$queryRaw<{ type: string }[]>`
      SELECT type FROM vndr WHERE id = ${courierUuid}::uuid
    `
    if (vndrRows.length === 0) throw new OpsClientError('not-found', 'courierVndrId not found')
    if (vndrRows[0]!.type !== 'COURIER') {
      throw new OpsClientError('invalid', 'courierVndrId does not reference a COURIER vendor')
    }

    // NAMED multi-program exception, inherited from the shared loop: one file
    // legitimately carries shipments of many programs, so the role is entered
    // ONCE and app.program_id is re-pinned per shipment inside the loop from
    // that shipment's OWN server-resolved program.
    await enterWriteRole(tx, 'fulfillment_write')

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, OPERATION), async () => {
      counts = await ingestStatusRowsWithinTx(tx, {
        rows: parsed.validRows.map((r) => ({
          awb: r.awb,
          status: r.status,
          courierTimestamp: r.courierTimestamp,
        })),
        expectedCourierWire: args.courierVndrId,
        vndrUuid: courierUuid,
        // fileId = clientKey: stable across a retry of the same
        // Idempotency-Key, and server-owned rather than taken from the
        // operator's filename.
        fileId: args.clientKey,
        // `ops:` marks the origin on the trail. An ops upload is a
        // distinguishable event from a courier's own POST even when the bytes
        // are identical, so an auditor reading shpt_status_event can tell an
        // operator-mediated update from a machine-to-machine one.
        sourceRef: `ops:${args.courierVndrId}|${args.clientKey}`,
        source: 'BATCH_FILE',
        traceId: args.traceId,
      })

      // Co-commit the ALLOW 6e in the SAME tx as the effect (spec 10c CC-1).
      // IDs and enum tokens only (S7/S10.5): no AWB, no row content. A
      // file-level upload has no single target resource, so resourceIds is
      // empty, mirroring commitBankFile and the device-inventory upload.
      await enqueue(tx, buildAuthzAuditEvent(opsAllow({ principalId: args.actorId, resourceIds: [], traceId: args.traceId })))
    })
  })

  return {
    fileId: args.clientKey,
    advanced: ran ? counts.advanced : 0,
    trailOnly: ran ? counts.trailOnly : 0,
    quarantined: ran ? counts.quarantined : 0,
    invalid: ran ? parsed.invalidRows.length : 0,
    invalidRows: ran ? parsed.invalidRows : [],
    deduped: !ran,
  }
}
