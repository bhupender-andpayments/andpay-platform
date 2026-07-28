import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import type { ShipToAmendedFactView } from './events.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'

/**
 * Thrown when the ship-to amend fact (fct.tms.assignment.ship_to_amended.v1)
 * arrives before its pending_pool_entry exists. The demand fact
 * (fct.tms.assignment.v1) and this amend fact travel on DIFFERENT topics with
 * no cross-topic ordering guarantee (T7), so an amend can legitimately race
 * ahead of the demand fact that creates the row. Throwing here (instead of
 * returning) rolls back the caller's transaction BEFORE any inbox row is
 * written, so the bus redelivers the amend. The demand fact is guaranteed
 * upstream, so redelivery terminates once it lands. Exported so callers can
 * distinguish this expected, self-resolving case from a genuine failure.
 */
export class NotYet extends Error {
  constructor(asgnId: string) {
    super(`no pending_pool_entry for ${asgnId} yet; redeliver`)
    this.name = 'NotYet'
  }
}

/**
 * D116 "consume + lock, defer reissue" (ratified). Projects
 * fct.tms.assignment.ship_to_amended.v1 onto the pending_pool_entry snapshot.
 * Two mutually-exclusive, rowcount-gated atomic UPDATEs replace any
 * read-dispatch_state-then-branch design (a TOCTOU hazard): each UPDATE's own
 * WHERE clause is the sole gate, evaluated atomically under the row's write
 * lock at UPDATE time, so a concurrent compose flipping dispatch_state cannot
 * cause a silent overwrite.
 *
 * - PRE-COMPOSITION (dispatch_state IS NULL): the snapshot is still live, so
 *   the amend updates ship_to_address/contact/mobile in place.
 * - POST-COMPOSITION (dispatch_state IS NOT NULL): the snapshot has already
 *   fed a composed artifact, so ship_to_address is preserved; the new address
 *   is captured in superseded_ship_to and the entry is LOCKED
 *   (ship_to_superseded = true). NEVER emits a reissue fact: reissue is a
 *   separate, deliberately-triggered, recorded action (deferred, not this
 *   consumer's job).
 * - Both UPDATEs are gated on amendmentSeq strictly increasing (monotonic
 *   apply); if neither fires, the delivery is a stale/duplicate seq, a no-op.
 *
 * No C4 read: every field comes from the event-carried payload.
 */
export async function projectShipToAmended(
  db: FulfillmentDb,
  env: Envelope<ShipToAmendedFactView>,
): Promise<{ deduped: boolean; applied: 'pre_composition' | 'locked' | 'stale_seq' }> {
  const p = env.payload
  const asgnUuid = toUuid(p.asgnId)

  // Program-lookup-first (mirrors holdEntry, batching.ts), done BEFORE opening
  // the transaction: an unknown asgn_id must throw (see NotYet), not return
  // normally, so no inbox row is ever written for a miss.
  const lookup = await db.$queryRaw<{ program_id: string }[]>`
    SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
  `
  if (lookup.length === 0) throw new NotYet(p.asgnId)
  const programUuid = lookup[0]!.program_id

  let applied: 'pre_composition' | 'locked' | 'stale_seq' = 'stale_seq'

  const ran = await db.$transaction(async (tx: Tx) => {
    return onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      await enterWriteScope(tx, 'fulfillment_write', programUuid)

      const shipToAddress = p.shipToAddress ?? null
      const contactName = p.contactName ?? null
      const mobile = p.mobile ?? null

      const pre = await tx.$queryRaw<{ id: string }[]>`
        UPDATE pending_pool_entry
        SET ship_to_address = COALESCE(${shipToAddress}, ship_to_address),
            ship_to_contact_name = COALESCE(${contactName}, ship_to_contact_name),
            ship_to_mobile = COALESCE(${mobile}, ship_to_mobile),
            ship_to_amendment_seq = ${p.amendmentSeq},
            updated_at = now()
        WHERE asgn_id = ${asgnUuid}::uuid
          AND dispatch_state IS NULL
          AND (ship_to_amendment_seq IS NULL OR ship_to_amendment_seq < ${p.amendmentSeq})
        RETURNING id
      `
      if (pre.length > 0) {
        applied = 'pre_composition'
        return
      }

      const locked = await tx.$queryRaw<{ id: string }[]>`
        UPDATE pending_pool_entry
        SET ship_to_superseded = true,
            superseded_ship_to = ${shipToAddress},
            ship_to_amendment_seq = ${p.amendmentSeq},
            updated_at = now()
        WHERE asgn_id = ${asgnUuid}::uuid
          AND (ship_to_amendment_seq IS NULL OR ship_to_amendment_seq < ${p.amendmentSeq})
        RETURNING id
      `
      applied = locked.length > 0 ? 'locked' : 'stale_seq'
    })
  })

  return { deduped: !ran, applied }
}
