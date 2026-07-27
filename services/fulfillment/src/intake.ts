import { newId, toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { loadFulfillmentConfig } from './authz-config.js'
import { unitFactEnvelope, UNIT_TOPIC } from './events.js'

// The manufacturer intake sheet (103a/103c/103d): the ONLY Unit-creating
// channel. S8-untrusted: verified class-6 identity and schema BEFORE any state
// change; an unverifiable or schema-invalid sheet is rejected whole.
export interface SerializedIntakeRow {
  kind: 'SERIALIZED'
  deviceSerial: string
  productType: string
  deviceQr: object
}
export interface QuantityLineIntakeRow {
  kind: 'QUANTITY_LINE'
  productType: string
  count: number
  qrString: string
}
export type IntakeRow = SerializedIntakeRow | QuantityLineIntakeRow

export interface IntakeSheet {
  fileId: string
  vndrId: string
  workQueue: string
  rows: IntakeRow[]
}

export interface IntakeResult {
  // Set only on a whole-sheet rejection; absent on a (possibly partial) accept.
  rejected?: 'unauthorized' | 'schema_invalid'
  createdUnitIds: string[]
  quarantined: number
  // true when the file was already processed (the {vendor}|{file_id} inbox key
  // hit): fn did not run, so createdUnitIds/quarantined report zero even though
  // the ORIGINAL ingest may have created units.
  deduped: boolean
}

function emptyResult(rejected: 'unauthorized' | 'schema_invalid'): IntakeResult {
  return { rejected, createdUnitIds: [], quarantined: 0, deduped: false }
}

// Whole-file schema validation (D103b): a row missing a REQUIRED field, or
// naming a kind other than the two known shapes, fails the file. This is
// distinct from a row that is well formed but business-ambiguous (D103d, see
// below), which is quarantined per-row instead of failing the file.
function isStructurallyValid(row: IntakeRow): boolean {
  const r = row as unknown as Record<string, unknown>
  if (typeof r.kind !== 'string') return false
  if (typeof r.productType !== 'string' || r.productType.length === 0) return false
  if (r.kind === 'SERIALIZED') {
    return (
      typeof r.deviceSerial === 'string' &&
      r.deviceSerial.length > 0 &&
      typeof r.deviceQr === 'object' &&
      r.deviceQr !== null &&
      !Array.isArray(r.deviceQr)
    )
  }
  if (r.kind === 'QUANTITY_LINE') {
    return (
      Number.isInteger(r.count) &&
      (r.count as number) > 0 &&
      typeof r.qrString === 'string' &&
      r.qrString.length > 0
    )
  }
  return false // an unrecognized kind is structurally invalid, not a business case
}

// STEP C only (spec 10c Task 4, re-split in fix wave 1): the transactional DB
// work for one manufacturer intake sheet (06.A file idempotency, per-row
// duplicate-serial quarantine, Unit inserts, outbox enqueue). Takes an
// ALREADY-authorized, ALREADY-schema-validated sheet: the caller MUST run
// STEP A (authorize) and STEP B (schema validation) before opening the
// transaction this runs in, so this alone never performs those checks and
// takes no claim (STEP C makes no use of it). Exported so a later ops API
// (T8) can run this effect, the E6 inbox dedup, and a server-resolved write
// scope together in ONE caller-supplied transaction, after doing its own
// ops-level authorize and STEP B.
export async function ingestIntakeSheetWithinTx(
  tx: Tx,
  sheet: IntakeSheet,
  traceId: string,
): Promise<IntakeResult> {
  const vndrUuid = toUuid(sheet.vndrId)
  const createdUnitIds: string[] = []
  let quarantined = 0

  // STEP C: file idempotency (06.A) on {vendor}|{file_id} via the inbox. A
  // re-ingest of the whole file is a no-op: fn does not run a second time.
  const ran = await onceWithin(tx, CONSUMER, `${sheet.vndrId}|${sheet.fileId}`, async () => {
      // Business-malformed detection (D103d): a device_serial repeated WITHIN
      // this file is well formed but ambiguous (which row is the real
      // procurement record?). NEVER auto-guess: keep the first occurrence,
      // quarantine every later occurrence. This is the concrete, documented
      // business-malformed rule for this task (chosen over an "unrecognized
      // product_type" rule because product_type is an open, extensible enum
      // per the schema comment, "SOUNDBOX | STANDEE | STICKER | ...", so a
      // hard-coded rejection list would reject legitimate new SKUs the corpus
      // has not fixed a value for; a within-file duplicate serial has no such
      // extensibility concern and is explicitly named in the task brief).
      const seenSerials = new Set<string>()

      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i]!
        const rowRef = `row-${i}`

        if (row.kind === 'SERIALIZED' && seenSerials.has(row.deviceSerial)) {
          await tx.$executeRaw`
            INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
            VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${'duplicate_device_serial_in_file'})
          `
          quarantined++
          continue
        }

        if (row.kind === 'SERIALIZED') {
          seenSerials.add(row.deviceSerial)
          const unitUuid = toUuid(newId('unit'))
          // Per-unit idempotency is {device_serial}|intake PLUS the
          // device_serial UNIQUE backstop (a re-submission of the same serial
          // in a LATER file is a no-op, not a quarantine: the file-level key
          // above already handles a re-submission of the SAME file).
          const won = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
            VALUES (${unitUuid}::uuid, ${'SERIALIZED'}, ${row.productType}, ${vndrUuid}::uuid, ${'IN_STOCK'}, ${row.deviceSerial}, ${JSON.stringify(row.deviceQr)}::jsonb, now())
            ON CONFLICT (device_serial) DO NOTHING
            RETURNING id::text AS id
          `
          if (won.length === 0) continue
          const unitId = fromUuid('unit', unitUuid)
          createdUnitIds.push(unitId)
          await enqueue(tx, {
            aggregateType: 'unit',
            aggregateId: unitId,
            eventType: UNIT_TOPIC,
            partitionKey: unitId,
            payload: unitFactEnvelope({
              payload: {
                unitId,
                kind: 'SERIALIZED',
                productType: row.productType,
                manufacturerVndr: sheet.vndrId,
                status: 'IN_STOCK',
                deviceSerial: row.deviceSerial,
              },
              dedupKey: `${row.deviceSerial}|intake`,
              traceId,
            }),
          })
          continue
        }

        // QUANTITY_LINE: no UNIQUE backstop exists for this shape (unlike
        // device_serial), so the {vendor}|{file_id}|{product_type} key is the
        // ONLY guard against double-counting a product_type repeated across
        // rows in one file (critique fix, check f): the second row with the
        // same product_type is a no-op, procured is NOT doubled.
        await onceWithin(tx, CONSUMER, `${sheet.vndrId}|${sheet.fileId}|${row.productType}`, async () => {
          const unitUuid = toUuid(newId('unit'))
          await tx.$executeRaw`
            INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, qr_string, procured, allocated, printed, dispatched, delivered, returned, scrapped, updated_at)
            VALUES (${unitUuid}::uuid, ${'QUANTITY_LINE'}, ${row.productType}, ${vndrUuid}::uuid, ${'IN_STOCK'}, ${row.qrString}, ${row.count}, 0, 0, 0, 0, 0, 0, now())
          `
          const unitId = fromUuid('unit', unitUuid)
          createdUnitIds.push(unitId)
          await enqueue(tx, {
            aggregateType: 'unit',
            aggregateId: unitId,
            eventType: UNIT_TOPIC,
            partitionKey: unitId,
            payload: unitFactEnvelope({
              payload: {
                unitId,
                kind: 'QUANTITY_LINE',
                productType: row.productType,
                manufacturerVndr: sheet.vndrId,
                status: 'IN_STOCK',
                count: row.count,
              },
              dedupKey: `${sheet.vndrId}|${sheet.fileId}|${row.productType}`,
              traceId,
            }),
          })
        })
      }
    })

  return { createdUnitIds, quarantined, deduped: !ran }
}

// Ingest one manufacturer intake sheet (S8, 105c, D103b, D103d, E1). Returns
// the outcome; NEVER throws on a rejection or a quarantined row (a thrown
// error is reserved for a genuine infrastructure failure, which rolls the
// whole file back per E1).
export async function ingestIntakeSheet(
  db: FulfillmentDb,
  claim: LeanClaim,
  sheet: IntakeSheet,
  traceId: string,
): Promise<IntakeResult> {
  // STEP A: authorize BEFORE any transaction opens (S8, 105c). The class-6
  // gate requires claim.scope.vndr === sheet.vndrId AND claim.scope.wq ===
  // sheet.workQueue (own-vendor-only); a non-class-6 claim hits the human gate
  // and is denied on an unknown role. Either way: no state change.
  const decision = authorize(
    claim,
    'sheet:submit-intake',
    { vndrId: sheet.vndrId, workQueue: sheet.workQueue },
    loadFulfillmentConfig(),
  )
  if (!decision.allowed) return emptyResult('unauthorized')

  // STEP B: whole-file schema validation BEFORE any transaction opens
  // (D103b). One structurally invalid row rejects the WHOLE file: no Units,
  // no intake_exception rows, no partial credit. This guard must NEVER throw
  // on untrusted input (a genuine throw is reserved for infra failure, E1): a
  // missing/null/non-array rows field, or a null/primitive row entry, is
  // schema_invalid, not a crash.
  if (
    !Array.isArray(sheet.rows) ||
    sheet.rows.some(
      (row) => row === null || typeof row !== 'object' || !isStructurallyValid(row as IntakeRow),
    )
  )
    return emptyResult('schema_invalid')

  return db.$transaction((tx: Tx) => ingestIntakeSheetWithinTx(tx, sheet, traceId))
}
