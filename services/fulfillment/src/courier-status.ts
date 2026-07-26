import { fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { SHIPMENT_TOPIC, shipmentFactEnvelope } from './events.js'

// The C3 forward ladder. FAILED and RETURNED are OFF-ladder: reachable from any
// in-flight ladder state, never from a settled one. RETURNED is an RTO and is
// deliberately distinct from FAILED, because it is the concrete trigger for the
// D116 superseding-reissue workflow (a NAMED DEFERRAL, not built here).
export const LADDER_RANK: Record<string, number> = {
  DISPATCHED_BY_VENDOR: 0,
  PICKED_UP: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
}
// Terminal is EXACTLY these two (ratified D9). FAILED is NOT terminal: a failed
// attempt can re-attempt forward, be delivered, or go RTO to RETURNED.
export const TERMINAL: ReadonlySet<string> = new Set(['DELIVERED', 'RETURNED'])

const KNOWN_STATUS: ReadonlySet<string> = new Set([...Object.keys(LADDER_RANK), 'FAILED', 'RETURNED'])

export type StatusSource = 'WEBHOOK' | 'BATCH_FILE' | 'OPS_MANUAL'

export function isKnownStatus(s: string): boolean {
  return KNOWN_STATUS.has(s)
}

export interface StatusUpdate {
  awb: string
  status: string
  courierTimestamp: Date // REPORTED by the courier, stored as data (S22)
  source: StatusSource
  sourceRef: string // {vendor}|{file_id} or {vendor}|{event_id}
  // Unlike ingestReturnSheet, which derives its trace from the pooled entries
  // it consumes, a courier status has NO prior internal trace to inherit: the
  // external submission IS the origin. So the caller trace is used and chained
  // onto both the trail row and the emitted fact (S21).
  traceId: string
}

export type AdvanceOutcome = 'advanced' | 'trail_only' | 'deduped' | 'unknown_awb'

/**
 * Advances one shpt_'s carrier status. Caller supplies the transaction, so the
 * advance, the trail append, and the outbox enqueue commit atomically (E1).
 *
 * Resolves shpt_ by AWB (F2) and NEVER auto-creates one (103d). Appends to the
 * append-only trail even for a stale status, because a stale report is still
 * history. Advances shpt.status only through ONE rowcount-gated atomic UPDATE,
 * so there is no read-then-branch TOCTOU window, and emits the transition fact
 * only when that UPDATE actually returns a row.
 */
export async function advanceShipmentStatus(tx: Tx, u: StatusUpdate): Promise<AdvanceOutcome> {
  const found = await tx.$queryRaw<{ id: string; program_id: string; courier_partner: string | null }[]>`
    SELECT id::text AS id, program_id::text AS program_id, courier_partner::text AS courier_partner
    FROM shpt WHERE awb = ${u.awb}
  `
  if (found.length === 0) return 'unknown_awb'

  // Already ::text out of uuid columns, so these are native uuid strings.
  // Do NOT toUuid them.
  const shptUuid = found[0]!.id
  const programUuid = found[0]!.program_id
  const courierUuid = found[0]!.courier_partner
  const shptWire = fromUuid('shpt', shptUuid)
  const tsIso = u.courierTimestamp.toISOString()

  let outcome: AdvanceOutcome = 'trail_only'

  // Per-transition idempotency (06.A): a re-reported status is a no-op, so the
  // body does not run twice and no duplicate trail row or fact appears.
  const ran = await onceWithin(tx, CONSUMER, `${shptWire}|${u.status}|${tsIso}`, async () => {
    await setProgramContext(tx, programUuid)

    await tx.$executeRaw`
      INSERT INTO shpt_status_event
        (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
      VALUES
        (${shptUuid}::uuid, ${programUuid}::uuid, ${u.status}, ${u.courierTimestamp},
         ${u.source}, ${u.sourceRef}, ${u.traceId})
    `

    // The ratified successor rule (D9). incomingIsLadder is true for the five
    // ranked states (DELIVERED included, rank 4); FAILED and RETURNED are not
    // ladder states, so incomingRank is -1 for them.
    const incomingIsLadder = Object.prototype.hasOwnProperty.call(LADDER_RANK, u.status)
    const incomingRank = incomingIsLadder ? LADDER_RANK[u.status]! : -1

    // updated_at = now() is mandatory: @updatedAt does not fire on raw SQL and
    // the column is NOT NULL with no default.
    //
    // Guard, in order:
    //  - current must be NON-terminal (DELIVERED/RETURNED never advance).
    //  - the incoming courier timestamp must be strictly newer (no regress).
    //  - THEN either the incoming is a non-ladder settle (FAILED/RETURNED,
    //    always permitted from a non-terminal state, including from FAILED), or
    //    it is a strictly-higher ladder rank than the current rank (a forward
    //    move; skips allowed; a FAILED current has rank -1 so any ladder rank
    //    is forward from it, which is the re-attempt path).
    const advanced = await tx.$queryRaw<{ id: string }[]>`
      UPDATE shpt
      SET status = ${u.status}, status_at = ${u.courierTimestamp},
          status_source = ${u.source}, updated_at = now()
      WHERE id = ${shptUuid}::uuid
        AND status NOT IN ('DELIVERED', 'RETURNED')
        AND (status_at IS NULL OR status_at < ${u.courierTimestamp})
        AND (
          ${incomingIsLadder}::boolean = false
          OR (${incomingRank}::int > CASE status
                WHEN 'DISPATCHED_BY_VENDOR' THEN 0
                WHEN 'PICKED_UP' THEN 1
                WHEN 'IN_TRANSIT' THEN 2
                WHEN 'OUT_FOR_DELIVERY' THEN 3
                ELSE -1 END)
        )
      RETURNING id::text AS id
    `
    if (advanced.length === 0) {
      outcome = 'trail_only'
      return
    }
    outcome = 'advanced'

    // The dedupKey MUST be per-transition. The spec-08 birth fact uses the bare
    // shpt wire id, so a bare key here would let an E6 inbox consumer dedup
    // every transition away as a duplicate of the birth.
    await enqueue(tx, {
      aggregateType: 'shpt',
      aggregateId: shptWire,
      eventType: SHIPMENT_TOPIC,
      partitionKey: shptWire,
      payload: shipmentFactEnvelope({
        payload: {
          shptId: shptWire,
          awb: u.awb,
          ...(courierUuid ? { courierPartner: fromUuid('vndr', courierUuid) } : {}),
          status: u.status,
          courierTimestamp: tsIso,
          statusSource: u.source,
        },
        dedupKey: `${shptWire}|${u.status}|${tsIso}`,
        traceId: u.traceId,
      }),
    })
  })

  return ran ? outcome : 'deduped'
}
