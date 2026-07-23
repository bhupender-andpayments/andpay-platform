import { enqueue, onceWithin } from '@andpay/outbox'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { eventKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import type { TmsDb } from './db.js'
import { assignmentFactEnvelope, TMS_ASSIGNMENT_TOPIC } from './events.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'

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
}

// Emit the demand fact for an already-inserted assignment (row present) and move
// it to pooled-for-fulfillment (ratified one-step lifecycle). Returns the asgn_
// wire id. Shared by the request join and the damage replacement (task 10).
export async function emitDemandFact(tx: Tx, asgnUuid: string, envId: string, traceId: string): Promise<string> {
  const rows = await tx.$queryRaw<AssignmentSnapshotRow[]>`
    SELECT a.merchant_id, a.program_id, a.tenant_id, a.merchant_display_name AS display_name,
           a.merchant_legal_name AS legal_name, a.merchant_mcc AS mcc, a.bank_reference_code, a.bank_display_name,
           a.ship_to_address, a.qr_value, a.vpa_value, a.soundbox, a.standee_count, a.sticker_count,
           a.billable, a.source_event_id
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
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      const pend = await tx.$queryRaw<PendingRowRow[]>`
        SELECT soundbox, standee_count, sticker_count, qr_value, vpa_value, ship_to_address
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

      const progUuid = toUuid(p.progId)
      await setProgramContext(tx, progUuid)

      const pr = pend[0]!
      const m = merch[0]!
      const t = ten[0]!
      const asgnUuid = toUuid(newId('asgn'))
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
          billable, demand_state, source_event_id, updated_at
        ) VALUES (
          ${asgnUuid}::uuid, ${mrchUuid}::uuid, ${progUuid}::uuid, ${tnntUuid}::uuid,
          ${m.display_name}, ${m.legal_name}, ${m.mcc},
          ${t.bank_reference_code}, ${t.display_name}, ${pr.ship_to_address},
          ${pr.qr_value}, ${pr.vpa_value}, ${pr.soundbox}, ${pr.standee_count}, ${pr.sticker_count},
          ${true}, ${'received'}, ${p.sourceEventId}, now()
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
