import { toUuid, fromUuid } from '@andpay/ids'
import { onceWithin } from '@andpay/outbox'
import { authorize, type LeanClaim } from '@andpay/authz'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { loadFulfillmentConfig } from './authz-config.js'
import { advanceShipmentStatus, isKnownStatus } from './courier-status.js'

export interface WebhookEvent {
  vndrId: string
  workQueue: string
  eventId: string
  awb: string
  status: string
  courierTimestamp: string // ISO 8601
}
export type CourierPayloadMapper = (raw: unknown) => WebhookEvent | null
export interface WebhookResult {
  rejected?: 'unauthorized' | 'schema_invalid'
  outcome?: 'advanced' | 'trail_only' | 'quarantined' | 'deduped'
}

// The v1 per-courier seam: the single courier already speaks the canonical
// shape, so the mapper validates that shape and never throws on untrusted input.
export const passthroughMapper: CourierPayloadMapper = (raw) => {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const fields = ['vndrId', 'workQueue', 'eventId', 'awb', 'status', 'courierTimestamp'] as const
  for (const f of fields) {
    if (typeof r[f] !== 'string' || (r[f] as string).length === 0) return null
  }
  if (Number.isNaN(new Date(r.courierTimestamp as string).getTime())) return null
  return {
    vndrId: r.vndrId as string,
    workQueue: r.workQueue as string,
    eventId: r.eventId as string,
    awb: r.awb as string,
    status: r.status as string,
    courierTimestamp: r.courierTimestamp as string,
  }
}

/**
 * The generic authenticated courier webhook handler (C6 port). Same S8-untrusted
 * gate and per-row ownership guard as the batch adapter, for a single event.
 * NO HTTP transport is built here: the NestJS route lands at step 9. The mapper
 * is the per-courier payload-adapter seam (v1 passthrough for the one courier).
 */
export async function ingestStatusWebhook(
  db: FulfillmentDb, raw: unknown, claim: LeanClaim, traceId: string,
  mapper: CourierPayloadMapper = passthroughMapper,
): Promise<WebhookResult> {
  // STEP A: map raw -> canonical BEFORE any authorize or transaction.
  const ev = mapper(raw)
  if (ev === null) return { rejected: 'schema_invalid' }

  // STEP B: file-level (event-level) authorize BEFORE any transaction (S8, 105c own-vendor).
  const decision = authorize(claim, 'shipment:submit-status', { vndrId: ev.vndrId, workQueue: ev.workQueue }, loadFulfillmentConfig())
  if (!decision.allowed) return { rejected: 'unauthorized' }

  const vndrUuid = toUuid(ev.vndrId)
  let outcome: 'advanced' | 'trail_only' | 'quarantined' | 'deduped' = 'quarantined'

  // STEP C: event idempotency {vendor}|{eventId} via the inbox; a replay of the
  // same event does not run again (deduped).
  const ran = await db.$transaction(async (tx: Tx) => {
    return onceWithin(tx, CONSUMER, `${ev.vndrId}|${ev.eventId}`, async () => {
      const quarantine = async (reason: string): Promise<void> => {
        await tx.$executeRaw`
          INSERT INTO courier_status_exception (vndr_id, channel, subject_ref, file_id, row_ref, reason_code)
          VALUES (${vndrUuid}::uuid, ${'WEBHOOK'}, ${ev.awb}, ${null}, ${null}, ${reason})
        `
        outcome = 'quarantined'
      }

      if (!isKnownStatus(ev.status)) {
        await quarantine('unknown_status')
        return
      }

      // shpt reads are open (USING true); no program context needed to resolve.
      const found = await tx.$queryRaw<{ courier_partner: string | null }[]>`
        SELECT courier_partner::text AS courier_partner FROM shpt WHERE awb = ${ev.awb}
      `
      if (found.length === 0) {
        await quarantine('unknown_awb')
        return
      }
      const cp = found[0]!.courier_partner
      if (cp === null) {
        await quarantine('courier_unassigned')
        return
      }
      // cp is already a native uuid string (selected ::text); compare on the wire id.
      if (fromUuid('vndr', cp) !== claim.scope.vndr) {
        await quarantine('wrong_courier')
        return
      }

      const adv = await advanceShipmentStatus(tx, {
        awb: ev.awb,
        status: ev.status,
        courierTimestamp: new Date(ev.courierTimestamp),
        source: 'WEBHOOK',
        sourceRef: `${ev.vndrId}|${ev.eventId}`,
        traceId,
      })
      // 'unknown_awb' from advanceShipmentStatus is unreachable here (existence
      // was already checked above). A genuine quarantine only comes from the
      // explicit quarantine() branches above, which already set outcome =
      // 'quarantined' and write the exception row. If we reach this line,
      // advanceShipmentStatus ran and can still return 'deduped' when the
      // inner per-(shpt,status,ts) key was already claimed by another channel
      // (e.g. the batch file adapter, or an earlier event with the same
      // status and exact courierTimestamp); that is a clean no-op, not a
      // quarantine, so it maps to 'deduped' here, not 'quarantined'.
      outcome = adv === 'advanced' ? 'advanced' : adv === 'trail_only' ? 'trail_only' : 'deduped'
    })
  })

  return { outcome: ran ? outcome : 'deduped' }
}
