import { newId, toUuid, fromUuid, InvalidIdError } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { loadFulfillmentConfig } from './authz-config.js'
import {
  PRINT_FOR_TOPIC,
  SHIPMENT_TOPIC,
  DISPATCH_TOPIC,
  printForFactEnvelope,
  shipmentFactEnvelope,
  dispatchFactEnvelope,
} from './events.js'

// The print/ship vendor's return sheet (spec 08, the SECOND C6 file-ingest
// adapter after intake.ts, checks 3/4/7). Pairs an already-in-inventory Unit
// to the merchant it was printed for and births/dedups the Shipment (shpt_)
// it travels on, keyed by AWB. S8-untrusted: verified class-6 identity and
// schema BEFORE any state change; an unverifiable or schema-invalid sheet is
// rejected whole, exactly like intake.ts.
export interface ReturnRow {
  deviceSerial: string
  asgnId: string
  awb: string
  courierCode?: string // FR-05 Courier Partner: resolves to a vndr_ COURIER via vndr.courier_code (spec 09)
}

export interface ReturnSheet {
  fileId: string
  vndrId: string
  workQueue: string
  rows: ReturnRow[]
}

export interface ReturnResult {
  // Set only on a whole-sheet rejection; absent on a (possibly partial) accept.
  rejected?: 'unauthorized' | 'schema_invalid'
  pairedUnitIds: string[]
  quarantined: number
  // newly-BORN shpt ids only (mirrors createdUnitIds's semantics in intake.ts):
  // a row whose AWB dedups onto an already-existing shpt does not add here.
  shptIds: string[]
  // true when the file was already processed (the {vendor}|{file_id} inbox key
  // hit): fn did not run, so every count above reports zero even though the
  // ORIGINAL ingest may have paired units and born shipments.
  deduped: boolean
}

function emptyResult(rejected: 'unauthorized' | 'schema_invalid'): ReturnResult {
  return { rejected, pairedUnitIds: [], quarantined: 0, shptIds: [], deduped: false }
}

// Whole-file schema validation: a row missing a required field fails the
// WHOLE file (mirrors intake.ts's isStructurallyValid). This must NEVER throw
// on untrusted input: a missing/null/non-string field is schema_invalid, not a
// crash. `courierCode` is optional and, if present, checked only for shape
// here. The vndr_ COURIER resolution happens per row inside the transaction
// (it needs a db handle). Per-courier AWB FORMAT validation stays deferred to
// step 9 (D3).
function isStructurallyValid(row: ReturnRow): boolean {
  const r = row as unknown as Record<string, unknown>
  return (
    typeof r.deviceSerial === 'string' &&
    r.deviceSerial.length > 0 &&
    typeof r.asgnId === 'string' &&
    r.asgnId.length > 0 &&
    typeof r.awb === 'string' &&
    r.awb.length > 0 &&
    (r.courierCode === undefined || typeof r.courierCode === 'string')
  )
}

interface RowEntrySnapshot {
  asgnUuid: string
  traceId: string
  createdAt: Date
  entryId: string // pending_pool_entry.id, the tie-break key (mirrors batching.ts)
}

interface ShptBirth {
  awb: string
  dispatchDate: Date
  unitIds: string[]
  entries: RowEntrySnapshot[]
}

interface CoveredGroup {
  programUuid: string
  btchUuid: string
  asgnUuids: Set<string>
  entries: RowEntrySnapshot[]
}

// The deterministic-oldest trace_id over a set of covered entries: order by
// created_at, then id (mirrors batching.ts's triggerBatch, never an unordered
// pick, fold correction 3).
function oldestTraceId(entries: RowEntrySnapshot[]): string {
  const sorted = [...entries].sort((a, b) => {
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime()
    if (byCreatedAt !== 0) return byCreatedAt
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
  })
  return sorted[0]!.traceId
}

// Ingest one print/ship vendor return sheet (S8, 105c, D103d, D106c, E1).
// Returns the outcome; NEVER throws on a rejection or a quarantined row (a
// thrown error is reserved for a genuine infrastructure failure, which rolls
// the whole file back per E1). `_traceId` is accepted for call-shape parity
// with ingestIntakeSheet but is deliberately UNUSED: every emitted fact here
// derives its traceId from the entities' own stored snapshot (the asgn's own
// pending_pool_entry.trace_id for print_for; the deterministic oldest-covered
// entry's trace_id for the per-batch dispatch fact and the per-shpt shipment
// fact), never from a caller-supplied value (fold correction 3). Unlike
// intake.ts (which mints brand-new Units with no prior trace lineage), every
// entity this function touches already carries a trace_id from the original
// TMS assignment fact, so re-deriving from that lineage is the more correct,
// deterministic source.
export async function ingestReturnSheet(
  db: FulfillmentDb,
  claim: LeanClaim,
  sheet: ReturnSheet,
  _traceId: string,
): Promise<ReturnResult> {
  // STEP A: authorize BEFORE any transaction opens (S8, 105c). own-vendor-only
  // (claim.scope.vndr === sheet.vndrId AND claim.scope.wq === sheet.workQueue);
  // a non-class-6 claim hits the human gate and is denied on an unknown role.
  // Either way: no state change.
  const decision = authorize(
    claim,
    'sheet:submit-return',
    { vndrId: sheet.vndrId, workQueue: sheet.workQueue },
    loadFulfillmentConfig(),
  )
  if (!decision.allowed) return emptyResult('unauthorized')

  // STEP B: whole-file schema validation BEFORE any transaction opens. One
  // structurally invalid row rejects the WHOLE file: no pairing, no
  // intake_exception rows, no partial credit.
  if (
    !Array.isArray(sheet.rows) ||
    sheet.rows.some((row) => row === null || typeof row !== 'object' || !isStructurallyValid(row as ReturnRow))
  )
    return emptyResult('schema_invalid')

  const vndrUuid = toUuid(sheet.vndrId)
  const pairedUnitIds: string[] = []
  let quarantined = 0

  // Newly-born shpts in THIS call, keyed by shpt wire id: accumulates every
  // unit that resolves onto that shpt across the whole file (even a LATER row
  // that dedups onto a shpt an EARLIER row in this same file just birthed),
  // so the shipment fact's unitIds is complete. A shpt that resolves to a
  // pre-existing row (born by a DIFFERENT, earlier ingest) never enters this
  // map, so no shipment fact fires for it here (no carrier transition, D106c).
  const shptBirths = new Map<string, ShptBirth>()

  // Covered-asgn grouping for the post-loop dispatch UPDATE + fact (fold
  // correction 1): SET LOCAL app.program_id is transaction-scoped, so a single
  // blanket UPDATE after the loop would run under only the LAST row's program
  // context and fail every OTHER program's RLS WITH CHECK. Grouping by
  // (program_id, btch_) and re-setting the context per group before its own
  // scoped UPDATE avoids that entirely.
  const coveredGroups = new Map<string, CoveredGroup>()

  // STEP C: file idempotency (06.A) on {vendor}|{file_id} via the inbox. A
  // re-ingest of the whole file is a no-op: fn does not run a second time.
  const ran = await db.$transaction(async (tx: Tx) => {
    return onceWithin(tx, CONSUMER, `${sheet.vndrId}|${sheet.fileId}`, async () => {
      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i]!
        const rowRef = `row-${i}`

        // (1) find `unit` by device_serial, ALSO reading its current shipment
        // (used by the already-paired guard right below); if none found,
        // quarantine (D103d: NO auto-create, ever). unit is permissive RLS,
        // no program context needed.
        const unitRows = await tx.$queryRaw<{ id: string; shipment: string | null }[]>`
          SELECT id::text AS id, shipment::text AS shipment FROM unit WHERE device_serial = ${row.deviceSerial}
        `
        if (unitRows.length === 0) {
          await tx.$executeRaw`
            INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
            VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${'device_not_in_inventory'})
          `
          quarantined++
          continue
        }
        const unitUuid = unitRows[0]!.id
        const unitWire = fromUuid('unit', unitUuid)

        // Review fix (orphan shpt guard): a unit that is ALREADY paired
        // (unit.shipment IS NOT NULL, persisted from an earlier successful
        // row, same file or an earlier one) is quarantined HERE, BEFORE the
        // shpt birth below. Without this guard the SAME device_serial
        // reappearing with a NEW awb would still INSERT a real shpt row and
        // emit a real (zero-unit) shipment fact: the per-unit onceWithin
        // below would no-op (the unit is already paired, so its body never
        // runs again), so the newly-born shpt would collect no units at all,
        // while unit.shipment keeps pointing at the ORIGINAL awb's shpt.
        // Reading persisted unit.shipment (not an in-process set) catches
        // this whether the repeat is within THIS file or in a later one.
        if (unitRows[0]!.shipment !== null) {
          await tx.$executeRaw`
            INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
            VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${'unit_already_paired'})
          `
          quarantined++
          continue
        }

        // row.asgnId is genuinely untrusted file content (unlike sheet.vndrId,
        // which is cross-checked against the authorized claim's own scope
        // above): STEP B only checked it is a non-empty string, not that it is
        // a well-formed asgn_ wire id. Guard the parse so a malformed id
        // quarantines this row instead of throwing and rolling back the whole
        // file (the global "never throw on untrusted input" constraint).
        let asgnUuid: string
        try {
          asgnUuid = toUuid(row.asgnId)
        } catch (e) {
          if (!(e instanceof InvalidIdError)) throw e
          await tx.$executeRaw`
            INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
            VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${'invalid_asgn_id'})
          `
          quarantined++
          continue
        }

        // (2) the asgn snapshot: tenant/program/batch/merchant/trace, all from
        // the event-carried pending_pool_entry row (no C4 read, D116).
        const entryRows = await tx.$queryRaw<
          {
            id: string
            tenant_id: string
            program_id: string
            batch: string | null
            merchant_id: string | null
            trace_id: string
            created_at: Date
          }[]
        >`
          SELECT id::text AS id, tenant_id::text AS tenant_id, program_id::text AS program_id,
                 batch::text AS batch, merchant_id::text AS merchant_id, trace_id, created_at
          FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
        `
        const entry = entryRows[0]
        if (!entry || entry.batch === null || entry.merchant_id === null) {
          // business-malformed (D103d-style): a well-formed but unresolvable
          // asgn (never pooled, or not yet batched/merchant-attributed).
          // Quarantine, never auto-guess, never crash.
          await tx.$executeRaw`
            INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
            VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${'asgn_not_found'})
          `
          quarantined++
          continue
        }
        const programUuid = entry.program_id
        const tenantUuid = entry.tenant_id
        const batchUuid = entry.batch
        const merchantUuid = entry.merchant_id

        // (2b) resolve the FR-05 courier partner, if the row names one. 103d:
        // an unknown or inactive courier is QUARANTINED, never auto-created.
        // vndr is permissive RLS, so no program context is needed for this
        // read (and none has been set yet for this row).
        let courierUuid: string | null = null
        if (row.courierCode !== undefined) {
          const courierRows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM vndr
            WHERE courier_code = ${row.courierCode} AND type = 'COURIER' AND status = 'ACTIVE'
          `
          if (courierRows.length === 0) {
            await tx.$executeRaw`
              INSERT INTO intake_exception (id, vndr_id, file_id, row_ref, reason_code)
              VALUES (gen_random_uuid(), ${vndrUuid}::uuid, ${sheet.fileId}, ${rowRef}, ${'unknown_courier'})
            `
            quarantined++
            continue
          }
          // Already ::text out of a uuid column, so this is a native uuid
          // string. Do NOT toUuid it.
          courierUuid = courierRows[0]!.id
        }

        // program-scoped writes below (shpt, pending_pool_entry): set fresh
        // per row, right before use (fold correction 1).
        await setProgramContext(tx, programUuid)

        // (3) birth/dedup shpt on AWB (D106c: one AWB = one shpt_). Bound
        // ONLY on birth (INSERT), never on a dedup hit: the dedup path below
        // reads the existing row with no program_id predicate, so it may
        // belong to a DIFFERENT Program, and an UPDATE against it could trip
        // the program RLS WITH CHECK. Rebinding on dedup is a step-9 item.
        // Prisma rejects a bound null param under an explicit ::uuid cast, so
        // branch: the bound uuid path casts, the null path uses a literal.
        const shptUuid = toUuid(newId('shpt'))
        const dispatchDate = new Date()
        const born =
          courierUuid !== null
            ? await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
                VALUES (${shptUuid}::uuid, ${row.awb}, ${courierUuid}::uuid, 'DISPATCHED_BY_VENDOR', ${dispatchDate}, ${tenantUuid}::uuid, ${programUuid}::uuid, now())
                ON CONFLICT (awb) DO NOTHING
                RETURNING id::text AS id
              `
            : await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
                VALUES (${shptUuid}::uuid, ${row.awb}, NULL, 'DISPATCHED_BY_VENDOR', ${dispatchDate}, ${tenantUuid}::uuid, ${programUuid}::uuid, now())
                ON CONFLICT (awb) DO NOTHING
                RETURNING id::text AS id
              `
        let finalShptUuid: string
        if (born.length > 0) {
          finalShptUuid = born[0]!.id
        } else {
          const existing = await tx.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM shpt WHERE awb = ${row.awb}
          `
          finalShptUuid = existing[0]!.id
        }
        const shptWire = fromUuid('shpt', finalShptUuid)

        if (born.length > 0) {
          shptBirths.set(shptWire, { awb: row.awb, dispatchDate, unitIds: [], entries: [] })
        }
        const birth = shptBirths.get(shptWire)

        const entrySnap: RowEntrySnapshot = {
          asgnUuid,
          traceId: entry.trace_id,
          createdAt: entry.created_at,
          entryId: entry.id,
        }

        // (4)+(5)+(6): per-unit idempotency wraps the unit UPDATE + the
        // print_for enqueue, so a re-upload of the SAME unit is a no-op.
        await onceWithin(tx, CONSUMER, `${unitWire}|print_for`, async () => {
          await tx.$executeRaw`
            UPDATE unit SET batch = ${batchUuid}::uuid, printed_for_merchant = ${merchantUuid}::uuid,
                   shipment = ${finalShptUuid}::uuid, updated_at = now()
            WHERE id = ${unitUuid}::uuid
          `
          pairedUnitIds.push(unitWire)
          if (birth) birth.unitIds.push(unitWire)

          await enqueue(tx, {
            aggregateType: 'unit',
            aggregateId: unitWire,
            eventType: PRINT_FOR_TOPIC,
            partitionKey: unitWire,
            payload: printForFactEnvelope({
              payload: {
                unitId: unitWire,
                asgnId: row.asgnId,
                deviceId: row.deviceSerial,
                printedForMerchant: fromUuid('mrch', merchantUuid),
                shptId: shptWire,
                awb: row.awb,
              },
              // the print_for fact carries THIS asgn's own snapshot trace_id,
              // never the ingest-call traceId (fold correction 3).
              dedupKey: `${unitWire}|print_for`,
              traceId: entry.trace_id,
            }),
          })
        })

        if (birth) birth.entries.push(entrySnap)

        const groupKey = `${programUuid}|${batchUuid}`
        let group = coveredGroups.get(groupKey)
        if (!group) {
          group = { programUuid, btchUuid: batchUuid, asgnUuids: new Set(), entries: [] }
          coveredGroups.set(groupKey, group)
        }
        group.asgnUuids.add(asgnUuid)
        group.entries.push(entrySnap)
      }

      // Post-loop: per (program, batch) group, advance dispatch_state and
      // emit ONE dispatch fact (fold correction 1: never a single blanket
      // UPDATE across groups, which would fail every non-last group's RLS
      // WITH CHECK).
      for (const group of coveredGroups.values()) {
        await setProgramContext(tx, group.programUuid)
        const asgnUuidList = [...group.asgnUuids]
        // Monotonicity guard (dispatch_state: null -> QR_GENERATED ->
        // SENT_TO_VENDOR -> DISPATCHED_BY_VENDOR must never regress or skip a
        // step): only ever advance an entry that has actually reached
        // SENT_TO_VENDOR (compose+dispatch both ran). Without this, a return
        // sheet arriving before the dispatch PM has run on this batch could
        // jump a NULL/QR_GENERATED entry straight to DISPATCHED_BY_VENDOR.
        // RETURNING is load-bearing: the emitted fact below must carry ONLY
        // the asgnIds this UPDATE actually advanced, never the full covered
        // group (which may include entries this UPDATE's WHERE excluded).
        const advanced = await tx.$queryRaw<{ asgn_id: string }[]>`
          UPDATE pending_pool_entry SET dispatch_state = 'DISPATCHED_BY_VENDOR', updated_at = now()
          WHERE asgn_id = ANY(${asgnUuidList}::uuid[]) AND program_id = ${group.programUuid}::uuid
            AND dispatch_state = 'SENT_TO_VENDOR'
          RETURNING asgn_id::text AS asgn_id
        `
        if (advanced.length === 0) continue // nothing in this group actually advanced: no fact to emit
        const btchWire = fromUuid('btch', group.btchUuid)
        const asgnIds = advanced.map((r) => fromUuid('asgn', r.asgn_id))
        await enqueue(tx, {
          aggregateType: 'batch',
          aggregateId: btchWire,
          eventType: DISPATCH_TOPIC,
          partitionKey: btchWire,
          payload: dispatchFactEnvelope({
            payload: { btchId: btchWire, asgnIds, dispatchState: 'DISPATCHED_BY_VENDOR' },
            // Review fix (partial-batch dedupKey): scoped to THIS file
            // (consistent with the 103c {vendor}|{file_id} file-idempotency
            // grammar). A batch can ship across multiple return files
            // (partial shipment); without the file scope, a second file
            // covering DIFFERENT asgns of the SAME batch would emit a second
            // fact with a disjoint asgnIds payload but the IDENTICAL
            // dedupKey as the first file's fact, which a downstream
            // onceWithin consumer would silently drop. A re-upload of the
            // SAME file still dedups correctly: the file-level
            // onceWithin(`${sheet.vndrId}|${sheet.fileId}`) guard above
            // no-ops the whole re-ingest before this code ever runs again.
            dedupKey: `${btchWire}|DISPATCHED_BY_VENDOR|${sheet.fileId}`,
            traceId: oldestTraceId(group.entries),
          }),
        })
      }

      // Post-loop: per newly-born shpt, ONE shipment fact carrying every unit
      // that resolved onto it across the whole file.
      for (const [shptWire, birth] of shptBirths) {
        await enqueue(tx, {
          aggregateType: 'shpt',
          aggregateId: shptWire,
          eventType: SHIPMENT_TOPIC,
          partitionKey: shptWire,
          payload: shipmentFactEnvelope({
            payload: {
              shptId: shptWire,
              awb: birth.awb,
              dispatchDate: birth.dispatchDate.toISOString(),
              unitIds: birth.unitIds,
              status: 'DISPATCHED_BY_VENDOR',
            },
            dedupKey: shptWire,
            traceId: oldestTraceId(birth.entries),
          }),
        })
      }
    })
  })

  return { pairedUnitIds, quarantined, shptIds: [...shptBirths.keys()], deduped: !ran }
}
