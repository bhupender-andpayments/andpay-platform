import { enqueue, onceWithin } from '@andpay/outbox'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { eventKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import type { TmsDb } from './db.js'
import {
  assignmentFactEnvelope,
  TMS_ASSIGNMENT_TOPIC,
  shipToAmendedFactEnvelope,
  TMS_SHIP_TO_AMENDED_TOPIC,
  activatedFactEnvelope,
  TMS_ACTIVATED_TOPIC,
} from './events.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'
import type { DevicePort } from './device-port.js'

// The consumer view of the identity enrollment fact (T7). Declared LOCALLY,
// never imported from the identity service (C4). Drift is caught by the wire
// schema (D120) and the root round-trip test, not by a cross-context import.
export interface EnrollmentFactView {
  enrollmentId: string
  mrchId: string
  progId: string
  tnntId: string
  status: string
  sourceEventId: string
}

interface PendingRowRow {
  soundbox: boolean
  standee_count: number
  sticker_count: number
  qr_value: string
  vpa_value: string
  ship_to_address: string
  contact_name: string | null
  mobile: string | null
  branch_code: string | null
}
interface MerchantProjRow { display_name: string; legal_name: string; mcc: string }
interface TenantProjRow { display_name: string; bank_reference_code: string }

// The exact (aliased) column shape of emitDemandFact's snapshot SELECT below.
// Typed directly against $queryRaw so the result needs no cast at all.
interface AssignmentSnapshotRow {
  merchant_id: string
  program_id: string
  tenant_id: string
  display_name: string
  legal_name: string
  mcc: string
  bank_reference_code: string
  bank_display_name: string
  ship_to_address: string
  qr_value: string
  vpa_value: string
  soundbox: boolean
  standee_count: number
  sticker_count: number
  billable: boolean
  source_event_id: string
  contact_name: string | null
  mobile: string | null
  branch_code: string | null
}

// Emit the demand fact for an already-inserted assignment (row present) and move
// it to pooled-for-fulfillment (ratified one-step lifecycle). Returns the asgn_
// wire id. Shared by the request join and the damage replacement (task 10).
export async function emitDemandFact(tx: Tx, asgnUuid: string, envId: string, traceId: string): Promise<string> {
  const rows = await tx.$queryRaw<AssignmentSnapshotRow[]>`
    SELECT a.merchant_id, a.program_id, a.tenant_id, a.merchant_display_name AS display_name,
           a.merchant_legal_name AS legal_name, a.merchant_mcc AS mcc, a.bank_reference_code, a.bank_display_name,
           a.ship_to_address, a.qr_value, a.vpa_value, a.soundbox, a.standee_count, a.sticker_count,
           a.billable, a.source_event_id, a.contact_name, a.mobile, a.branch_code
    FROM assignment a WHERE a.id = ${asgnUuid}::uuid
  `
  if (rows.length === 0) throw new Error(`emitDemandFact: assignment ${asgnUuid} not found`)
  const a = rows[0]!
  const asgnId = fromUuid('asgn', asgnUuid)
  await enqueue(tx, {
    aggregateType: 'assignment',
    aggregateId: asgnId,
    eventType: TMS_ASSIGNMENT_TOPIC,
    partitionKey: asgnId,
    payload: assignmentFactEnvelope({
      payload: {
        asgnId,
        mrchId: fromUuid('mrch', a.merchant_id),
        progId: fromUuid('prog', a.program_id),
        tnntId: fromUuid('tnnt', a.tenant_id),
        merchantDisplayName: a.display_name,
        merchantLegalName: a.legal_name,
        merchantMcc: a.mcc,
        bankReferenceCode: a.bank_reference_code,
        bankDisplayName: a.bank_display_name,
        shipToAddress: a.ship_to_address,
        qrValue: a.qr_value,
        vpaValue: a.vpa_value,
        soundbox: a.soundbox,
        standeeCount: a.standee_count,
        stickerCount: a.sticker_count,
        billable: a.billable,
        demandState: 'pooled-for-fulfillment',
        sourceEventId: a.source_event_id,
        // spec 06a: recipient contact snapshot. Null (a pre-06a row) becomes an
        // absent optional field, keeping the fact D120 FULL-compatible.
        contactName: a.contact_name ?? undefined,
        mobile: a.mobile ?? undefined,
        // Phase 3 Task 4: Branch Code snapshot (BRD 5.1b). Optional on the wire
        // (FULL compat, no v2); populated for every new assignment (ingest-mandatory).
        // Null (a pre-Task-4 row) becomes an absent optional field, same as above.
        branchCode: a.branch_code ?? undefined,
      },
      dedupKey: eventKey(envId, 'tms.assignment'),
      traceId,
    }),
  })
  await tx.$executeRaw`UPDATE assignment SET demand_state = 'pooled-for-fulfillment', updated_at = now() WHERE id = ${asgnUuid}::uuid`
  return asgnId
}

// The ingest-to-assignment join (D116). On the enrollment fact: find the pending
// row by the {file_id}|{row_no} correlation id (sourceEventId), snapshot the
// merchant from merchant_projection and the bank from tenant_projection (no C4
// read), create exactly one asgn_ (idempotent on source_event_id), emit the
// demand fact, and move to pooled-for-fulfillment. All within one E1 tx wrapped
// in onceWithin (E6). Built with only the TmsDb (check 2).
export async function createAssignmentFromEnrollment(
  db: TmsDb,
  env: Envelope<EnrollmentFactView>,
): Promise<{ created: boolean; asgnId?: string }> {
  const p = env.payload
  let result: { created: boolean; asgnId?: string } = { created: false }

  await db.$transaction(async (tx: Tx) => {
    // Fix wave (spec 10d consolidated defect): enter tms_write FIRST, before
    // onceWithin's inbox dedup INSERT (the leading write in this
    // transaction), so no statement here ever runs as the table owner.
    // progUuid is a pure transform of the fact's own progId (no DB lookup
    // needed), so it is safe to resolve before the dedup guard without
    // weakening the idempotency check itself.
    const progUuid = toUuid(p.progId)
    await enterWriteScope(tx, 'tms_write', progUuid)
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      const pend = await tx.$queryRaw<PendingRowRow[]>`
        SELECT soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address, contact_name, mobile, branch_code
        FROM pending_row WHERE correlation_id = ${p.sourceEventId}
      `
      if (pend.length === 0) throw new Error(`pending row not found for ${p.sourceEventId}`)

      const mrchUuid = toUuid(p.mrchId)
      const merch = await tx.$queryRaw<MerchantProjRow[]>`
        SELECT display_name, legal_name, mcc FROM merchant_projection WHERE id = ${mrchUuid}::uuid
      `
      if (merch.length === 0) throw new Error(`merchant projection not ready for ${p.mrchId}`)

      const tnntUuid = toUuid(p.tnntId)
      const ten = await tx.$queryRaw<TenantProjRow[]>`
        SELECT display_name, bank_reference_code FROM tenant_projection WHERE id = ${tnntUuid}::uuid
      `
      if (ten.length === 0) throw new Error(`tenant projection not ready for ${p.tnntId}`)

      const pr = pend[0]!
      const m = merch[0]!
      const t = ten[0]!
      const asgnUuid = toUuid(newId('asgn'))
      // Phase 2 task 3 (D-F): the provenance marker, computed locally (no
      // fact-schema change) inside this same transaction. If merchant_id
      // already has at least one existing assignment, this one is
      // ADDITIONAL; otherwise it is the merchant's first and is INITIAL.
      // v1 known edge (documented on the schema field too): decided by
      // processing order, not a DB constraint, so two rows for a brand-new
      // merchant processed concurrently could both observe zero existing
      // rows here and both be marked INITIAL. Acceptable for v1 (the marker
      // is informational provenance, not an authoritative ordering
      // guarantee); no locking added for it.
      const priorCount = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM assignment WHERE merchant_id = ${mrchUuid}::uuid
      `
      const origin = Number(priorCount[0]!.n) > 0 ? 'ADDITIONAL' : 'INITIAL'
      // updated_at is @updatedAt in the Prisma schema, which is client-API
      // middleware only (it does not run for $queryRaw/$executeRaw) and the
      // column has no DB-level DEFAULT (unlike created_at), so it must be set
      // explicitly here, same as projections.ts does for its two tables.
      const won = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO assignment (
          id, merchant_id, program_id, tenant_id,
          merchant_display_name, merchant_legal_name, merchant_mcc,
          bank_reference_code, bank_display_name, ship_to_address,
          qr_value, vpa_value, soundbox, standee_count, sticker_count,
          billable, demand_state, origin, source_event_id, contact_name, mobile, branch_code, updated_at
        ) VALUES (
          ${asgnUuid}::uuid, ${mrchUuid}::uuid, ${progUuid}::uuid, ${tnntUuid}::uuid,
          ${m.display_name}, ${m.legal_name}, ${m.mcc},
          ${t.bank_reference_code}, ${t.display_name}, ${pr.ship_to_address},
          ${pr.qr_value}, ${pr.vpa_value}, ${pr.soundbox}, ${pr.standee_count}, ${pr.sticker_count},
          ${true}, ${'received'}, ${origin}, ${p.sourceEventId}, ${pr.contact_name}, ${pr.mobile}, ${pr.branch_code}, now()
        )
        ON CONFLICT (source_event_id) DO NOTHING
        RETURNING id
      `
      if (won.length === 0) return // already created (idempotent, check 3)

      const asgnId = await emitDemandFact(tx, asgnUuid, env.id, env.traceId)
      await tx.$executeRaw`UPDATE pending_row SET status = 'consumed' WHERE correlation_id = ${p.sourceEventId}`
      result = { created: true, asgnId }
    })
  })
  return result
}

// D116 superseding re-instruction (Fork D): a ship-to amend after the assignment
// has already been snapshotted into the demand fact. Idempotent on
// (asgnId, amendmentSeq) via a stable inbox key (06.A rule 3 shape, composed
// locally since this is not itself sourced from an inbound envelope; the fact
// dedupKey below wraps this key via eventKey, which is 06.A rule 4). The
// post-batch amendment lock is fixture-deferred (gated on a Fulfillment batch
// fact, step 7); v1 here just performs the amend and emits the fact.
export async function amendShipTo(
  db: TmsDb,
  asgnId: string,
  newShipToAddress: string,
  amendmentSeq: number,
  traceId: string,
  recipient?: { contactName?: string; mobile?: string },
): Promise<{ amended: boolean }> {
  const asgnUuid = toUuid(asgnId)
  // Idempotent on (asgnId, amendmentSeq) via a stable inbox key (06.A rule 3).
  const dedupKey = `${asgnId}|ship_to_amend|${amendmentSeq}`
  // spec 06a: an amend may correct the recipient contact/mobile too. COALESCE so
  // an address-only amend (recipient omitted) never wipes an existing contact.
  const contactName = recipient?.contactName ?? null
  const mobile = recipient?.mobile ?? null
  let amended = false
  await db.$transaction(async (tx: Tx) => {
    // Fork-E named exception (spec 10d Task 3, check 1/8): amendShipTo carries
    // NO program on the wire at all (no param, no body field), so program_id
    // is resolved SERVER-SIDE from the target assignment row itself (D99: it
    // never comes from a caller), then the write scope is entered BEFORE the
    // onceWithin dedup insert and the UPDATE, so every write in this
    // transaction runs under tms_write with the row's OWN program bound to
    // app.program_id; the assignment_scoped WITH CHECK then fail-closes on
    // any mismatch or an unset value.
    const target = await tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id FROM assignment WHERE id = ${asgnUuid}::uuid
    `
    if (target.length === 0) throw new Error(`amendShipTo: assignment ${asgnId} not found`)
    await enterWriteScope(tx, 'tms_write', target[0]!.program_id)

    const ran = await onceWithin(tx, CONSUMER, dedupKey, async () => {
      // Post-batch lock is fixture-deferred (gated on a Fulfillment batch fact, step 7).
      await tx.$executeRaw`
        UPDATE assignment
        SET ship_to_address = ${newShipToAddress},
            contact_name = COALESCE(${contactName}::text, contact_name),
            mobile = COALESCE(${mobile}::text, mobile),
            updated_at = now()
        WHERE id = ${asgnUuid}::uuid
      `
      await enqueue(tx, {
        aggregateType: 'assignment',
        aggregateId: asgnId,
        eventType: TMS_SHIP_TO_AMENDED_TOPIC,
        partitionKey: asgnId,
        payload: shipToAmendedFactEnvelope({
          payload: { asgnId, shipToAddress: newShipToAddress, amendmentSeq, contactName: recipient?.contactName, mobile: recipient?.mobile },
          dedupKey: eventKey(dedupKey, 'tms.assignment.ship_to_amended'),
          traceId,
        }),
      })
    })
    amended = ran
  })
  return { amended }
}

// D116 activation (Fork C): device activation orchestration flows through the
// DevicePort seam (C6/T11), never a direct partner or AWS IoT call from this
// function. The port call happens OUTSIDE the transaction (it is an external
// side effect); the state change and fact emission are wrapped together in one
// onceWithin-guarded transaction (E1, E6) keyed on `${asgnId}|activate`, so a
// redelivered activation call does not re-run the effect. Device identity and
// activation facts are identical across adapter families (C6/T11 applied to
// devices).
//
// Phase 5 Task 2 (D-H.1): the transaction BODY is extracted into
// activateAssignmentWithinTx below so the class-3 ops trigger
// (activateAssignmentOps, ops.ts) can co-commit its ALLOW 6e INSIDE the same
// onceWithin as the UPDATE+fact, without duplicating the write logic. This
// function's own signature, behaviour, and error message are UNCHANGED: it
// still resolves the port result OUTSIDE the tx, then opens its own
// transaction with no onAudit callback.
export async function activateAssignmentWithinTx(
  tx: Tx,
  asgnId: string,
  activatedAt: string,
  traceId: string,
  opts?: { onAudit?: (tx: Tx) => Promise<void> },
): Promise<{ activated: boolean }> {
  const asgnUuid = toUuid(asgnId)
  const dedupKey = `${asgnId}|activate`
  // Fork-E named exception (spec 10d Task 3, check 1/8): activateAssignment
  // carries NO program on the wire at all, so program_id is resolved
  // SERVER-SIDE from the target assignment row itself (D99: never a caller
  // param), then the write scope is entered BEFORE the onceWithin dedup
  // insert and the UPDATE, exactly like amendShipTo above.
  const target = await tx.$queryRaw<{ program_id: string }[]>`
    SELECT program_id FROM assignment WHERE id = ${asgnUuid}::uuid
  `
  if (target.length === 0) throw new Error(`activateAssignment: assignment ${asgnId} not found`)
  await enterWriteScope(tx, 'tms_write', target[0]!.program_id)

  const ran = await onceWithin(tx, CONSUMER, dedupKey, async () => {
    await tx.$executeRaw`UPDATE assignment SET activated_at = ${activatedAt}::timestamptz, demand_state = 'activated', updated_at = now() WHERE id = ${asgnUuid}::uuid`
    await enqueue(tx, {
      aggregateType: 'assignment',
      aggregateId: asgnId,
      eventType: TMS_ACTIVATED_TOPIC,
      partitionKey: asgnId,
      payload: activatedFactEnvelope({
        payload: { asgnId, activatedAt },
        dedupKey: eventKey(dedupKey, 'tms.assignment.activated'),
        traceId,
      }),
    })
    // The 6e ALLOW co-commits INSIDE this same onceWithin (spec 10c CC-1,
    // activateAssignmentOps only): a redelivered/duplicate activation is a
    // no-op for BOTH the domain effect and the audit, exactly like holdRecord.
    if (opts?.onAudit) await opts.onAudit(tx)
  })
  return { activated: ran }
}

export async function activateAssignment(
  db: TmsDb,
  asgnId: string,
  port: DevicePort,
  deviceRef: string,
  traceId: string,
): Promise<{ activated: boolean }> {
  const result = await port.activate({ asgnId, deviceRef }) // through the device port (Fork C)
  return db.$transaction((tx: Tx) => activateAssignmentWithinTx(tx, asgnId, result.activatedAt, traceId))
}
