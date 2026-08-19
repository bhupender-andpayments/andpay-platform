import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import type { AssignmentFactView } from './events.js'
import type { ReplacementRaisedFactView } from './unit-lifecycle.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { enterWriteRole, enterWriteScope } from './write-context.js'

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
          asgn_id, tenant_id, program_id, merchant_id, soundbox, dispatch_group, standee_count, sticker_count, billable,
          merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
          ship_to_address, ship_to_contact_name, ship_to_mobile, branch_code, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at
        ) VALUES (
          ${toUuid(p.asgnId)}::uuid, ${toUuid(p.tnntId)}::uuid, ${progUuid}::uuid, ${toUuid(p.mrchId)}::uuid, ${p.soundbox}, ${p.dispatchGroup ?? null}, ${p.standeeCount}, ${p.stickerCount}, ${p.billable},
          ${p.merchantDisplayName}, ${p.merchantLegalName}, ${p.merchantMcc}, ${p.bankReferenceCode}, ${p.bankDisplayName},
          ${p.shipToAddress}, ${p.contactName ?? null}, ${p.mobile ?? null}, ${p.branchCode ?? null}, ${p.qrValue}, ${p.vpaValue}, ${'POOLED'}, ${p.sourceEventId}, ${env.traceId}, now()
        )
        ON CONFLICT (asgn_id) DO NOTHING
        RETURNING id::text AS id
      `
      wrote = won.length > 0
    })
  })
  return { deduped: !wrote }
}

/**
 * fct.tms.assignment.replacement_raised.v1, the POOL half: stamp the PARENT's
 * pending_pool_entry with replacement_raised so batch and pool reads can badge
 * the damaged dispatch without a cross-context read (C4). The UNIT half of the
 * same fact (the damaged device write-off) lives in unit-lifecycle.ts under
 * its own dedup suffix; the two projections are independently idempotent, the
 * same split damage-case.ts uses for the two case transitions.
 *
 * The fact carries no progId, so the program scope is re-pinned from the
 * target row itself (M7/S16: resolved server-side from the aggregate, never a
 * payload field), the exact pattern of tms damage-case.ts and the return
 * sheet's per-row setProgramContext. A parent with no pool row (never
 * projected, or a pre-pool legacy dispatch) is a no-op, not an error: the
 * marker is a read-side convenience and the case itself lives in tms.
 */
export async function projectReplacementToPool(
  db: FulfillmentDb,
  env: Envelope<ReplacementRaisedFactView>,
): Promise<{ advanced: number }> {
  let advanced = 0
  await db.$transaction(async (tx: Tx) => {
    // Role FIRST, before onceWithin's inbox INSERT, so no statement here ever
    // runs as the table owner (spec 10d).
    await enterWriteRole(tx, 'fulfillment_write')
    await onceWithin(tx, CONSUMER, `${env.dedupKey}|pool_replacement_raised`, async () => {
      const parentUuid = toUuid(env.payload.replacedAsgnId)
      const rows = await tx.$queryRaw<{ program_id: string }[]>`
        SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${parentUuid}::uuid
      `
      if (rows.length === 0) return
      await setProgramContext(tx, rows[0]!.program_id)
      advanced = await tx.$executeRaw`
        UPDATE pending_pool_entry SET replacement_raised = true, updated_at = now()
        WHERE asgn_id = ${parentUuid}::uuid AND replacement_raised = false
      `
    })
  })
  return { advanced }
}
