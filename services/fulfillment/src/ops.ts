import { fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { instanceKey } from '@andpay/keys'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'
import { advanceShipmentStatus, type AdvanceOutcome } from './courier-status.js'
import { SHIPMENT_TOPIC, shipmentFactEnvelope } from './events.js'

// spec 10c ops writes on shpt_ (Task 6). Both handlers are class-3 human ops
// actions (D-3); the ops HTTP edge (T9) calls these in-process and enforces
// step-up there, NOT here (the domain op assumes an already-authorized,
// stepped-up caller). Each resolves the target shpt_'s program SERVER-SIDE
// (never a request body, M7/S16/D99), enters the fulfillment_write scope
// FIRST, then runs its effect under a client-key instance dedup (rule 1,
// 06.A) via the shared E6 inbox, so a replay of the same clientKey does not
// double-apply.
//
// C3-bypass containment: `overrideTerminal` is the ONLY function in this repo
// that writes shpt.status without the C3 terminal guard. `correctStatus`
// NEVER bypasses C3: it goes only through `advanceShipmentStatus`'s single
// rowcount-gated UPDATE (courier-status.ts), which excludes DELIVERED and
// RETURNED. A correction that tries to exit a terminal is therefore
// naturally non-advancing, and override_reason stays NULL (advanceShipmentStatus
// never sets it).

interface ShptProgramAwb { programId: string; awb: string; courierPartner: string | null }

async function resolveProgramAndAwb(tx: Tx, shptId: string): Promise<ShptProgramAwb> {
  const found = await tx.$queryRaw<{ program_id: string; awb: string; courier_partner: string | null }[]>`
    SELECT program_id::text AS program_id, awb, courier_partner::text AS courier_partner
    FROM shpt WHERE id = ${shptId}::uuid
  `
  if (found.length === 0) throw new Error('shpt not found')
  return { programId: found[0]!.program_id, awb: found[0]!.awb, courierPartner: found[0]!.courier_partner }
}

/**
 * A normal manual status correction. Routed ONLY through `advanceShipmentStatus`
 * as an OPS_MANUAL source, so it is subject to the SAME C3 successor-table
 * validation as any courier event: a terminal-exit attempt yields the
 * non-advancing outcome ('trail_only'), never a status change, and
 * override_reason is never written on this path.
 *
 * `deduped: true` means this call was a client-key replay of an EARLIER call
 * (the E6 inbox already ran the effect); `outcome` is only meaningful when
 * `deduped` is false, and is `null` on a replay (unambiguous, unlike
 * overloading advanceShipmentStatus's own 'deduped' outcome, which means the
 * inner per-transition key was already claimed, a different, narrower thing).
 */
export async function correctStatus(
  db: FulfillmentDb,
  args: { shptId: string; status: string; courierTimestamp: Date; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; outcome: AdvanceOutcome | null }> {
  let outcome: AdvanceOutcome | null = null
  const ran = await db.$transaction(async (tx: Tx) => {
    const { programId, awb } = await resolveProgramAndAwb(tx, args.shptId)
    await enterWriteScope(tx, 'fulfillment_write', programId)
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:status-correction'), async () => {
      outcome = await advanceShipmentStatus(tx, {
        awb,
        status: args.status,
        courierTimestamp: args.courierTimestamp,
        source: 'OPS_MANUAL',
        sourceRef: args.actorId,
        traceId: args.traceId,
      })
    })
  })
  return { deduped: !ran, outcome: ran ? outcome : null }
}

/**
 * The privileged terminal override: the ONLY sanctioned C3 bypass (it can
 * reopen a locked terminal state, DELIVERED or RETURNED). A mandatory,
 * non-empty overrideReason is enforced here as defense-in-depth (the edge,
 * T9, enforces it too). The UPDATE deliberately omits the terminal guard;
 * the appended shpt_status_event carries override_reason NOT NULL, so the
 * bypass is always domain-audited.
 *
 * DD1 (critical): the free-text overrideReason NEVER rides the emitted fact
 * or any log line. It lives ONLY on the shpt_status_event.override_reason
 * domain column. The fact reuses the SAME envelope builder / SHIPMENT_TOPIC
 * as the courier path, IDs-only. The human-readable 6e audit-trail entry is
 * emitted later, at the edge (T9), not here.
 *
 * Returns `{ overridden: true }` unconditionally on success: the override is
 * in effect whether THIS call applied it or a prior replay of the same
 * clientKey already did.
 */
export async function overrideTerminal(
  db: FulfillmentDb,
  args: {
    shptId: string
    status: string
    courierTimestamp: Date
    overrideReason: string
    clientKey: string
    actorId: string
    traceId: string
  },
): Promise<{ deduped: boolean; overridden: boolean }> {
  if (!args.overrideReason.trim()) throw new Error('override_reason required')

  const ran = await db.$transaction(async (tx: Tx) => {
    const { programId, awb, courierPartner } = await resolveProgramAndAwb(tx, args.shptId)
    await enterWriteScope(tx, 'fulfillment_write', programId)
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:terminal-override'), async () => {
      // The deliberate C3 bypass: no `status NOT IN ('DELIVERED', 'RETURNED')`
      // guard, unlike advanceShipmentStatus's gated UPDATE. This is the ONLY
      // place in the codebase that writes shpt.status this way.
      await tx.$executeRaw`
        UPDATE shpt
        SET status = ${args.status}, status_at = ${args.courierTimestamp},
            status_source = 'OPS_MANUAL', updated_at = now()
        WHERE id = ${args.shptId}::uuid
      `
      await tx.$executeRaw`
        INSERT INTO shpt_status_event
          (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id, override_reason)
        VALUES
          (${args.shptId}::uuid, ${programId}::uuid, ${args.status}, ${args.courierTimestamp},
           'OPS_MANUAL', ${args.actorId}, ${args.traceId}, ${args.overrideReason})
      `

      const shptWire = fromUuid('shpt', args.shptId)
      const tsIso = args.courierTimestamp.toISOString()
      await enqueue(tx, {
        aggregateType: 'shpt',
        aggregateId: shptWire,
        eventType: SHIPMENT_TOPIC,
        partitionKey: shptWire,
        payload: shipmentFactEnvelope({
          payload: {
            shptId: shptWire,
            awb,
            ...(courierPartner ? { courierPartner: fromUuid('vndr', courierPartner) } : {}),
            status: args.status,
            courierTimestamp: tsIso,
            statusSource: 'OPS_MANUAL',
          },
          dedupKey: `${shptWire}|${args.status}|${tsIso}`,
          traceId: args.traceId,
        }),
      })
    })
  })
  return { deduped: !ran, overridden: true }
}
