import { toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { stepKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { DISPATCH_TOPIC, dispatchFactEnvelope, type BatchFactPayload } from './events.js'

// which artifacts a snapshot entry gets (from the snapshot alone, C4-safe)
function artifactTypesFor(e: { soundbox: boolean; standee_count: number; sticker_count: number }): string[] {
  const t: string[] = []
  if (e.soundbox) t.push('SOUNDBOX_IMG')
  if (e.standee_count > 0) t.push('STANDEE_IMG')
  if (e.sticker_count > 0) t.push('STICKER_IMG')
  return t
}

/**
 * The dispatch-lifecycle PM (spec 08 Task 6, checks 1/7/10): consumes
 * fulfillment's own fct.fulfillment.batch.v1 fact and runs compose + dispatch
 * as two onceWithin-guarded units under ONE db.$transaction (E1, check 10).
 * Ratified design: intra-process, no command topic. The dispatch lifecycle
 * instance IS the batch; a saga_instance row (flow_type='dispatch_lifecycle',
 * id=toUuid(btchId)) is the durable anchor, hand-inlined ON CONFLICT DO
 * NOTHING exactly as ensurePool inlines batch_pool's anchor (batching.ts:57-61
 * precedent: SagaEngine.start opens its own connection and cannot join this
 * tx). Compose and dispatch each write a saga_step row inline for
 * observability plus step-idempotency (Field 10).
 *
 * Using onceWithin (not SagaEngine.runStep) is deliberate: it makes
 * inbox-dedup + effect + fact-enqueue commit in ONE transaction, so there is
 * no crash window where the inbox says "processed" but the effect never ran.
 *
 * Reads ONLY pending_pool_entry (the event-carried snapshot), composed_artifact,
 * and bank_composition_config, all in the fulfillment schema (C4): never a
 * TMS/Identity table. Facts are IDs-only (S7): {btchId, asgnIds, dispatchState}.
 *
 * traceId: BOTH dispatch facts carry env.traceId, the consumed batch fact's own
 * trace (already deterministically-oldest, set by triggerBatch). This is
 * deliberately NOT derived from any entries.trace_id read back off an
 * unordered SELECT or UPDATE...RETURNING: a batch's entries were pooled from
 * DIFFERENT demand facts and legitimately carry different trace_ids, so
 * picking one via row order would be non-deterministic. env.traceId is the
 * single, deterministic source for every fact this step emits.
 */
export async function consumeBatchFact(
  db: FulfillmentDb,
  env: Envelope<BatchFactPayload>,
): Promise<{ deduped: boolean; composed: number }> {
  const p = env.payload
  const btchUuid = toUuid(p.btchId)
  const programUuid = toUuid(p.programId)
  const tenantUuid = toUuid(p.tenantId)
  let composed = 0

  const ran = await db.$transaction(async (tx: Tx) => {
    return onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      // durable lifecycle anchor (reuse saga_* tables; hand-inline per btch_,
      // start() cannot join this tx - see batching.ts:57-61).
      await tx.$executeRaw`
        INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
        VALUES (${btchUuid}::uuid, 'dispatch_lifecycle', 1, 'running', now())
        ON CONFLICT (id) DO NOTHING
      `
      await setProgramContext(tx, programUuid) // program-scoped writes below

      // COMPOSE step (idempotent per {btch_}|compose via the step row + onceWithin dedupKey).
      await onceWithin(tx, CONSUMER, `${p.btchId}|compose`, async () => {
        await tx.$executeRaw`
          INSERT INTO saga_step (instance_id, name, status, attempts, idempotency_key, updated_at)
          VALUES (${btchUuid}::uuid, 'compose', 'completed', 1, ${stepKey(p.btchId, 'compose')}, now())
          ON CONFLICT (instance_id, name) DO NOTHING
        `
        const entries = await tx.$queryRaw<
          {
            asgn_id: string
            merchant_display_name: string
            qr_value: string
            bank_reference_code: string
            soundbox: boolean
            standee_count: number
            sticker_count: number
          }[]
        >`
          SELECT asgn_id::text AS asgn_id, merchant_display_name, qr_value,
                 bank_reference_code, soundbox, standee_count, sticker_count
          FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
        `

        // bank_composition_config keys on (tenant_id, bank_code) - the table's
        // own @@unique([tenantId, bankCode]) - so the lookup matches each
        // entry's OWN bank_reference_code, not a single tenant-wide row: a
        // batch may legitimately mix banks. Cached per bank_code to avoid
        // repeat queries within one batch.
        const bankConfigCache = new Map<string, string | null>()
        async function bankConfigRefFor(bankCode: string): Promise<string | null> {
          if (bankConfigCache.has(bankCode)) return bankConfigCache.get(bankCode) ?? null
          const cfg = await tx.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM bank_composition_config
            WHERE tenant_id = ${tenantUuid}::uuid AND bank_code = ${bankCode}
          `
          const ref = cfg[0]?.id ?? null
          bankConfigCache.set(bankCode, ref)
          return ref
        }

        for (const e of entries) {
          const bankConfigRef = await bankConfigRefFor(e.bank_reference_code)
          for (const artifactType of artifactTypesFor(e)) {
            const assetRef = `s3://ap-south-1/fulfillment/artifacts/${p.btchId}/${e.asgn_id}/${artifactType}` // rasterization deferred
            // e.asgn_id is already the native uuid (selected as `::text` off a
            // uuid column, not a wire id), so it is used directly here, NOT
            // re-decoded via toUuid (which expects a wire-form id or a bare
            // 26-char payload and throws on a 36-char uuid string).
            await tx.$executeRaw`
              INSERT INTO composed_artifact (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref)
              VALUES (gen_random_uuid(), ${e.asgn_id}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${artifactType}, ${assetRef}, ${e.merchant_display_name}, ${e.qr_value}, ${bankConfigRef}::uuid)
            `
            composed++
          }
        }
        await tx.$executeRaw`
          UPDATE pending_pool_entry SET dispatch_state = 'QR_GENERATED', updated_at = now()
          WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
        `
        const asgnIds = entries.map((e) => fromUuid('asgn', e.asgn_id))
        await enqueue(tx, {
          aggregateType: 'batch',
          aggregateId: p.btchId,
          eventType: DISPATCH_TOPIC,
          partitionKey: p.btchId,
          payload: dispatchFactEnvelope({
            payload: { btchId: p.btchId, asgnIds, dispatchState: 'QR_GENERATED' },
            dedupKey: `${p.btchId}|QR_GENERATED`,
            traceId: env.traceId,
          }),
        })
      })

      // DISPATCH step (idempotent per {btch_}|dispatch). Package availability is
      // produced on demand by package.ts (Task 7); this step advances state + fact.
      await onceWithin(tx, CONSUMER, `${p.btchId}|dispatch`, async () => {
        await tx.$executeRaw`
          INSERT INTO saga_step (instance_id, name, status, attempts, idempotency_key, updated_at)
          VALUES (${btchUuid}::uuid, 'dispatch', 'completed', 1, ${stepKey(p.btchId, 'dispatch')}, now())
          ON CONFLICT (instance_id, name) DO NOTHING
        `
        const rows = await tx.$queryRaw<{ asgn_id: string }[]>`
          UPDATE pending_pool_entry SET dispatch_state = 'SENT_TO_VENDOR', updated_at = now()
          WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid AND dispatch_state = 'QR_GENERATED'
          RETURNING asgn_id::text AS asgn_id
        `
        const asgnIds = rows.map((r) => fromUuid('asgn', r.asgn_id))
        await enqueue(tx, {
          aggregateType: 'batch',
          aggregateId: p.btchId,
          eventType: DISPATCH_TOPIC,
          partitionKey: p.btchId,
          payload: dispatchFactEnvelope({
            payload: { btchId: p.btchId, asgnIds, dispatchState: 'SENT_TO_VENDOR' },
            dedupKey: `${p.btchId}|SENT_TO_VENDOR`,
            traceId: env.traceId,
          }),
        })
      })

      // fold correction 4: the saga_instance legitimately STAYS
      // status='running' here. The dispatch lifecycle does not terminate at
      // SENT_TO_VENDOR; it is resumed later (a future task) by the
      // return-sheet ingest event. No terminal-completion UPDATE belongs in
      // this function.
    })
  })

  return { deduped: !ran, composed }
}
