import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import type { AssignmentFactView } from './events.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'

export async function projectDemandFact(db: FulfillmentDb, env: Envelope<AssignmentFactView>): Promise<{ deduped: boolean }> {
  const p = env.payload
  let wrote = false
  await db.$transaction(async (tx: Tx) => {
    // Fix wave (spec 10d consolidated defect): enter fulfillment_write FIRST,
    // before onceWithin's inbox dedup INSERT (the leading write in this
    // transaction), so no statement here ever runs as the table owner.
    // progUuid is a pure transform of the fact's own progId (no DB lookup
    // needed), so it is safe to resolve before the dedup guard without
    // weakening the idempotency check itself.
    const progUuid = toUuid(p.progId)
    await enterWriteScope(tx, 'fulfillment_write', progUuid)
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      // RETURNING id, so we report a fresh write ONLY when the row was actually
      // won. A redelivered asgn_ under a FRESH dedupKey passes the inbox guard but
      // hits the asgn_id conflict; without RETURNING we would falsely report a
      // fresh write (the tms assignment.ts createAssignmentFromEnrollment
      // precedent uses this exact two-layer onceWithin plus RETURNING-gated
      // outer-variable pattern; ingest.ts's single-layer RETURNING check has no
      // onceWithin and is not the precedent here).
      const won = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO pending_pool_entry (
          asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
          merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
          ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at
        ) VALUES (
          ${toUuid(p.asgnId)}::uuid, ${toUuid(p.tnntId)}::uuid, ${progUuid}::uuid, ${toUuid(p.mrchId)}::uuid, ${p.soundbox}, ${p.standeeCount}, ${p.stickerCount}, ${p.billable},
          ${p.merchantDisplayName}, ${p.merchantLegalName}, ${p.merchantMcc}, ${p.bankReferenceCode}, ${p.bankDisplayName},
          ${p.shipToAddress}, ${p.contactName ?? null}, ${p.mobile ?? null}, ${p.qrValue}, ${p.vpaValue}, ${'POOLED'}, ${p.sourceEventId}, ${env.traceId}, now()
        )
        ON CONFLICT (asgn_id) DO NOTHING
        RETURNING id::text AS id
      `
      wrote = won.length > 0
    })
  })
  return { deduped: !wrote }
}
