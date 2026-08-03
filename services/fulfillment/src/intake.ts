import { newId, toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'
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
  // The manufacturer file's "Sim No" column (an ICCID). OPTIONAL: only SIM-
  // bearing devices carry it. Subscriber-linkable, so sensitive-by-default:
  // persisted to unit.sim_no for capture, but NEVER placed on a fact payload
  // (S7, see events.ts) or any read surface, pending the architecture PII/
  // residency ruling.
  simNo?: string
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
      !Array.isArray(r.deviceQr) &&
      // simNo is OPTIONAL; only its type is gated when present (absent stays
      // valid, an empty/non-string simNo does not). Belt-and-suspenders on top
      // of the edge parser for the ops re-ingest path that builds rows directly.
      (r.simNo === undefined || (typeof r.simNo === 'string' && r.simNo.length > 0))
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

// Whole-SHEET STEP B (D103b), exported so a caller that must NOT run STEP A
// (spec 10c Task 8: resolveIntakeException in ops.ts, whose class-3 operator
// is authorized at the HTTP edge, not via this file's own vendor-authorize)
// can still run the SAME schema validation `ingestIntakeSheet` uses, on the
// corrected sheet, BEFORE opening a transaction. A missing/null/non-array
// rows field, or a null/primitive row entry, is invalid, never a crash.
export function isSheetStructurallyValid(sheet: IntakeSheet): boolean {
  return (
    Array.isArray(sheet.rows) &&
    sheet.rows.every((row) => row !== null && typeof row === 'object' && isStructurallyValid(row as IntakeRow))
  )
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
  // Path separation (SIM No fast-follow, R2): the manufacturer-intake path
  // passes flagDuplicates:true, so a repeat serial or a duplicate ICCID is
  // FLAGGED for review (BRD). The ops correction path (resolveIntakeException)
  // and any other caller omit it, keeping the legacy silent-no-op semantics
  // byte-for-byte. Optional with a default so the correction call site is
  // unchanged.
  opts: { flagDuplicates?: boolean } = {},
): Promise<IntakeResult> {
  const { flagDuplicates = false } = opts
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
      // Fast-follow (SIM No capture): within-file duplicate-ICCID detection,
      // sibling of seenSerials. Populated ONLY on the manufacturer-intake path
      // (flagDuplicates); the ops correction path leaves it empty and keeps its
      // legacy semantics untouched.
      const seenSimNos = new Set<string>()

      // Quarantine one row to intake_exception (D103d), same shape as the
      // existing within-file duplicate-serial flag: IDs plus a reason_code
      // ONLY, row_ref locates the row in the source file. NO device_serial and
      // NO ICCID are stored here. Sensitive-by-default holds even in the flag
      // path; the operator resolves via file_id + row_ref against the file.
      const flag = async (rowRef: string, reasonCode: string): Promise<void> => {
        await tx.$executeRaw`
          INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
          VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${reasonCode})
        `
        quarantined++
      }

      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i]!
        const rowRef = `row-${i}`

        if (row.kind === 'SERIALIZED' && seenSerials.has(row.deviceSerial)) {
          await flag(rowRef, 'duplicate_device_serial_in_file')
          continue
        }

        if (row.kind === 'SERIALIZED') {
          // Confirm 3 (spec 15) - the ICCID-dup path is DELIBERATELY asymmetric
          // with the serial-dup path. A duplicate ICCID means a DIFFERENT real
          // device carrying a CONFLICTING SIM. It must NOT block the device:
          // D118 dispatch/tracking does not consume the ICCID (that is FR-07,
          // deferred), so blocking a real device on a not-yet-used field
          // over-couples the device lifecycle to the SIM conflict. The unit is
          // CREATED with sim_no NULL and the ICCID conflict is flagged
          // SEPARATELY. Two flavors, detected on the intake path only:
          //   - within-file: the ICCID was already stored by an earlier row
          //     (keep the first occurrence's ICCID);
          //   - cross-unit: the ICCID is already bound to a prior unit. The
          //     all-time SELECT satisfies the BRD "recent uploads" window and
          //     is safe because the action is FLAG not reject. It is an internal
          //     same-context write-path comparison, never a read surface (the
          //     value is compared, never surfaced), consistent with S7.
          let iccidDupReason: string | null = null
          let simNoForInsert: string | null = row.simNo ?? null
          if (flagDuplicates && row.simNo !== undefined) {
            if (seenSimNos.has(row.simNo)) {
              iccidDupReason = 'duplicate_sim_no_in_file'
              simNoForInsert = null
            } else {
              const simDup = await tx.$queryRaw<{ one: number }[]>`
                SELECT 1 AS one FROM unit WHERE sim_no = ${row.simNo} LIMIT 1
              `
              if (simDup.length > 0) {
                iccidDupReason = 'duplicate_sim_no_existing_unit'
                simNoForInsert = null
              }
            }
          }

          seenSerials.add(row.deviceSerial)
          const unitUuid = toUuid(newId('unit'))
          // sim_no (ICCID): the stored value is NULL for a non-SIM row OR for a
          // duplicate ICCID (Confirm 3). Bound as a text parameter, never
          // interpolated; it never rides into the fact enqueued below (S7).
          const won = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, sim_no, updated_at)
            VALUES (${unitUuid}::uuid, ${'SERIALIZED'}, ${row.productType}, ${vndrUuid}::uuid, ${'IN_STOCK'}, ${row.deviceSerial}, ${JSON.stringify(row.deviceQr)}::jsonb, ${simNoForInsert}, now())
            ON CONFLICT (device_serial) DO NOTHING
            RETURNING id::text AS id
          `
          if (won.length === 0) {
            // The serial already exists: the SAME device, so no second unit.
            // The legacy (correction) path keeps this silent no-op backstop; the
            // manufacturer-intake path (flagDuplicates) FLAGS it (BRD "same
            // Soundbox ID in ... recent uploads, flag for review"). PRECEDENCE:
            // the serial path owns this row, so even when the ICCID was ALSO a
            // duplicate, NO separate ICCID flag is raised and seenSimNos is left
            // untouched. Either way: no second unit, no second fact.
            if (flagDuplicates) await flag(rowRef, 'duplicate_device_serial_existing_unit')
            continue
          }
          // A new unit WAS created. Flag the ICCID conflict now (precedence:
          // only after a real insert). Record the ICCID in the within-file
          // seen-set ONLY when it was actually stored (never a NULL/duplicate).
          if (iccidDupReason !== null) {
            await flag(rowRef, iccidDupReason)
          } else if (row.simNo !== undefined) {
            seenSimNos.add(row.simNo)
          }
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
  if (!isSheetStructurallyValid(sheet)) return emptyResult('schema_invalid')

  // Non-ops entry point (spec 10d Task 4, M-role only: unit and
  // intake_exception are PLATFORM-ONLY, WITH CHECK(true), no program scope).
  // Enters fulfillment_write FIRST so every write in the shared
  // ingestIntakeSheetWithinTx body runs under the non-owner role instead of
  // the table owner; no program is set (there is none). The ops entry
  // (resolveIntakeException, spec 10c) enters the role itself, so the shared
  // body is left untouched.
  return db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    // Manufacturer-intake path: duplicates (repeat serial or duplicate ICCID)
    // are FLAGGED for review, not silently dropped (BRD, R2 path separation).
    return ingestIntakeSheetWithinTx(tx, sheet, traceId, { flagDuplicates: true })
  })
}
