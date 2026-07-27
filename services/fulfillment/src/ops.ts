import { fromUuid, toUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { instanceKey } from '@andpay/keys'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'
import { advanceShipmentStatus, type AdvanceOutcome } from './courier-status.js'
import { SHIPMENT_TOPIC, shipmentFactEnvelope } from './events.js'
import { holdEntryWithinTx, triggerBatchWithinTx } from './batching.js'

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

interface PriorArtifact {
  id: string
  asgnId: string
  btchId: string
  tenantId: string
  programId: string
  artifactType: string
  assetReference: string
  labelDisplayName: string
  labelQr: string
  bankConfigRef: string | null
}

async function resolvePriorArtifact(tx: Tx, asgnUuid: string): Promise<PriorArtifact> {
  const rows = await tx.$queryRaw<
    {
      id: string; asgn_id: string; btch_id: string; tenant_id: string; program_id: string
      artifact_type: string; asset_reference: string; label_display_name: string; label_qr: string
      bank_config_ref: string | null
    }[]
  >`
    SELECT id::text AS id, asgn_id::text AS asgn_id, btch_id::text AS btch_id, tenant_id::text AS tenant_id,
           program_id::text AS program_id, artifact_type, asset_reference, label_display_name, label_qr,
           bank_config_ref::text AS bank_config_ref
    FROM composed_artifact
    WHERE asgn_id = ${asgnUuid}::uuid AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `
  if (rows.length === 0) throw new Error('composed_artifact not found for asgnId')
  const r = rows[0]!
  return {
    id: r.id,
    asgnId: r.asgn_id,
    btchId: r.btch_id,
    tenantId: r.tenant_id,
    programId: r.program_id,
    artifactType: r.artifact_type,
    assetReference: r.asset_reference,
    labelDisplayName: r.label_display_name,
    labelQr: r.label_qr,
    bankConfigRef: r.bank_config_ref,
  }
}

/**
 * Re-composition (Task 7, check 4/D116 same-ship-to path): regenerates a
 * composed_artifact row for the SAME ship-to only. The program is resolved
 * SERVER-SIDE from the prior (latest, non-superseded) composed_artifact for
 * this asgnId, never a request body (M7/S16/D99).
 *
 * SHIP-TO GUARD (Fork C): a `requestedShipTo` that differs from the CURRENT
 * `pending_pool_entry.ship_to_address` is rejected outright; the D116 reissue
 * path (a genuine address change) stays deferred. This function never reads
 * or writes `ship_to_superseded` / `superseded_ship_to`. The guard runs
 * INSIDE the onceWithin effect, so a rejection throws and rolls back the
 * whole transaction, including the inbox insert (E6): the clientKey is never
 * burned by a rejected attempt, and a corrected retry with the same clientKey
 * still works.
 *
 * The new row reuses the prior row's snapshot fields VERBATIM (asgn_id,
 * btch_id, tenant_id, program_id, artifact_type, asset_reference,
 * label_display_name, label_qr, bank_config_ref) under a fresh id; the prior
 * row is then marked superseded (superseded_by/superseded_at). composed_artifact
 * has NO updated_at column, so none is set.
 */
export async function recomposeArtifact(
  db: FulfillmentDb,
  args: { asgnId: string; requestedShipTo?: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; artifactId: string | null }> {
  const asgnUuid = toUuid(args.asgnId)
  let newArtifactId: string | null = null

  const ran = await db.$transaction(async (tx: Tx) => {
    const prior = await resolvePriorArtifact(tx, asgnUuid)
    await enterWriteScope(tx, 'fulfillment_write', prior.programId)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:recompose-artifact'), async () => {
      if (args.requestedShipTo !== undefined) {
        const shipToRows = await tx.$queryRaw<{ ship_to_address: string }[]>`
          SELECT ship_to_address FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
        `
        const currentShipTo = shipToRows[0]?.ship_to_address
        if (currentShipTo !== undefined && args.requestedShipTo !== currentShipTo) {
          throw new Error(
            're-composition cannot change ship-to; a genuine ship-to change is a reissue (D116, deferred)',
          )
        }
      }

      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO composed_artifact
          (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref)
        VALUES
          (gen_random_uuid(), ${prior.asgnId}::uuid, ${prior.btchId}::uuid, ${prior.tenantId}::uuid, ${prior.programId}::uuid,
           ${prior.artifactType}, ${prior.assetReference}, ${prior.labelDisplayName}, ${prior.labelQr}, ${prior.bankConfigRef}::uuid)
        RETURNING id::text AS id
      `
      newArtifactId = inserted[0]!.id

      await tx.$executeRaw`
        UPDATE composed_artifact SET superseded_by = ${newArtifactId}::uuid, superseded_at = now()
        WHERE id = ${prior.id}::uuid
      `
    })
  })

  return { deduped: !ran, artifactId: ran ? newArtifactId : null }
}

/**
 * record-HOLD as a class-3 ops action (check 3d sibling): resolves the
 * target's program server-side from `pending_pool_entry` (never a request
 * body), enters the write scope, then delegates the effect itself to the
 * injected-tx `holdEntryWithinTx` (Task 4) under a client-key dedup.
 */
export async function holdRecord(
  db: FulfillmentDb,
  args: { asgnId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  const asgnUuid = toUuid(args.asgnId)

  const ran = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
    `
    if (rows.length === 0) throw new Error('pending_pool_entry not found for asgnId')
    await enterWriteScope(tx, 'fulfillment_write', rows[0]!.program_id)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:record-hold'), async () => {
      await holdEntryWithinTx(tx, args.asgnId, { operatorId: args.actorId })
    })
  })

  return { deduped: !ran }
}

/**
 * record-RELEASE (check 3d sibling): the reverse of record-HOLD, HELD ->
 * POOLED only (an already-POOLED or BATCHED row is left untouched, same
 * rowcount-gated pattern as holdEntryWithinTx). Stamps released_by_actor/
 * released_at. Step-up is enforced at the ops HTTP edge (Task 9), not here.
 */
export async function releaseRecord(
  db: FulfillmentDb,
  args: { asgnId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean; released: boolean }> {
  const asgnUuid = toUuid(args.asgnId)
  let released = false

  const ran = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
    `
    if (rows.length === 0) throw new Error('pending_pool_entry not found for asgnId')
    await enterWriteScope(tx, 'fulfillment_write', rows[0]!.program_id)

    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:record-release'), async () => {
      const count = await tx.$executeRaw`
        UPDATE pending_pool_entry
        SET pool_status = 'POOLED', released_by_actor = ${args.actorId}::uuid, released_at = now(), updated_at = now()
        WHERE asgn_id = ${asgnUuid}::uuid AND pool_status = 'HELD'
      `
      released = count > 0
    })
  })

  return { deduped: !ran, released }
}

/**
 * The MANUAL batch trigger as a class-3 ops action (check 3c/7 sibling): the
 * program is a caller-supplied programWire here (not resolved from a target
 * row, there is none), still converted server-side to its uuid form for the
 * write scope. Deliberately NO outer onceWithin: `triggerBatchWithinTx`'s own
 * onceWithin, keyed `batch|{tenant}|{program}|MANUAL|{epoch}` with
 * `epoch = clientKey`, already provides the client-key idempotency, so a
 * double-fire with the same clientKey collapses to exactly one batch.
 */
export async function manualBatch(
  db: FulfillmentDb,
  args: { tenantWire: string; programWire: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ btchId: string } | null> {
  const programUuid = toUuid(args.programWire)

  return db.$transaction(async (tx: Tx) => {
    await enterWriteScope(tx, 'fulfillment_write', programUuid)
    const res = await triggerBatchWithinTx(tx, args.tenantWire, args.programWire, 'MANUAL', {
      epoch: args.clientKey,
      actorUuid: args.actorId,
    })
    return res ? { btchId: res.btchId } : null
  })
}

/**
 * Vendor suspend (check 3e sibling): vndr is PLATFORM-ONLY (no program_id,
 * permissive FORCE RLS, `vndr_v1` USING(true)/WITH CHECK(true)), so this
 * enters the write role bare, with no program to set. Step-up is enforced at
 * the ops HTTP edge (Task 9), not here.
 */
export async function suspendVendor(
  db: FulfillmentDb,
  args: { vndrId: string; clientKey: string; actorId: string; traceId: string },
): Promise<{ deduped: boolean }> {
  const vndrUuid = toUuid(args.vndrId)

  const ran = await db.$transaction(async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
    return onceWithin(tx, CONSUMER, instanceKey(args.clientKey, 'ops:vendor-suspend'), async () => {
      await tx.$executeRaw`
        UPDATE vndr SET status = 'SUSPENDED', updated_at = now() WHERE id = ${vndrUuid}::uuid
      `
    })
  })

  return { deduped: !ran }
}
