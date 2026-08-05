import { toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { stepKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'
import { DISPATCH_TOPIC, dispatchFactEnvelope, type BatchFactPayload } from './events.js'
import { renderCollateralPdf, type ArtifactType } from './collateral/renderer.js'
import type { AssetStore } from './storage/asset-store.js'

// which artifacts a snapshot entry gets (from the snapshot alone, C4-safe)
function artifactTypesFor(e: { soundbox: boolean; standee_count: number; sticker_count: number }): ArtifactType[] {
  const t: ArtifactType[] = []
  if (e.soundbox) t.push('SOUNDBOX_IMG')
  if (e.standee_count > 0) t.push('STANDEE_IMG')
  if (e.sticker_count > 0) t.push('STICKER_IMG')
  return t
}

// The per-type key into imageTemplates JSONB (SOUNDBOX/STANDEE/STICKER) from the
// artifact type (SOUNDBOX_IMG/...). Reads the per-type sub-object leniently.
function templateFor(imageTemplates: unknown, artifactType: ArtifactType): unknown {
  const key = artifactType.replace('_IMG', '')
  if (imageTemplates !== null && typeof imageTemplates === 'object' && key in imageTemplates) {
    return (imageTemplates as Record<string, unknown>)[key]
  }
  return undefined
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
  assetStore: AssetStore,
): Promise<{ deduped: boolean; composed: number }> {
  const p = env.payload
  const btchUuid = toUuid(p.btchId)
  const programUuid = toUuid(p.programId)
  const tenantUuid = toUuid(p.tenantId)
  let composed = 0

  const ran = await db.$transaction(async (tx: Tx) => {
    // Fix wave (spec 10d consolidated defect): enter fulfillment_write FIRST,
    // before onceWithin's inbox dedup INSERT AND the leading saga_instance
    // INSERT below (both were, before this fix, run as the table owner).
    // programUuid is already resolved above, outside the transaction.
    await enterWriteScope(tx, 'fulfillment_write', programUuid)
    return onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      // durable lifecycle anchor (reuse saga_* tables; hand-inline per btch_,
      // start() cannot join this tx - see batching.ts:57-61).
      await tx.$executeRaw`
        INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
        VALUES (${btchUuid}::uuid, 'dispatch_lifecycle', 1, 'running', now())
        ON CONFLICT (id) DO NOTHING
      `

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
            merchant_legal_name: string
            bank_display_name: string
            vpa_value: string
            qr_value: string
            bank_reference_code: string
            branch_code: string | null
            soundbox: boolean
            standee_count: number
            sticker_count: number
          }[]
        >`
          SELECT asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name, bank_display_name,
                 vpa_value, qr_value, bank_reference_code, branch_code, soundbox, standee_count, sticker_count
          FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
        `

        // bank_composition_config keys on (tenant_id, bank_code, branch_code) -
        // the table's own @@unique([tenantId, bankCode, branchCode]), widened
        // in Phase 3 Task 5a - so the lookup matches each entry's OWN
        // bank_reference_code (a batch may legitimately mix banks) AND its
        // OWN branch_code. Fallback order (Task 5a): an exact branch match ->
        // the bank-level default row (the '' sentinel, never null, closing
        // the NULL-distinct unique-index gotcha) -> null (current no-branding
        // behavior). Cached per (bank_code, branch_code) to avoid repeat
        // queries within one batch.
        interface BankConfigRow {
          id: string
          branding_params: unknown
          image_templates: unknown
          logo_master_ref: string | null
        }
        const bankConfigCache = new Map<string, BankConfigRow | null>()
        async function bankConfigFor(bankCode: string, branchCode: string | null): Promise<BankConfigRow | null> {
          const cacheKey = `${bankCode}|${branchCode ?? ''}`
          if (bankConfigCache.has(cacheKey)) return bankConfigCache.get(cacheKey) ?? null
          let row: BankConfigRow | null = null
          if (branchCode) {
            const exact = await tx.$queryRaw<BankConfigRow[]>`
              SELECT id::text AS id, branding_params, image_templates, logo_master_ref FROM bank_composition_config
              WHERE tenant_id = ${tenantUuid}::uuid AND bank_code = ${bankCode} AND branch_code = ${branchCode}
            `
            row = exact[0] ?? null
          }
          if (row === null) {
            const fallback = await tx.$queryRaw<BankConfigRow[]>`
              SELECT id::text AS id, branding_params, image_templates, logo_master_ref FROM bank_composition_config
              WHERE tenant_id = ${tenantUuid}::uuid AND bank_code = ${bankCode} AND branch_code = ''
            `
            row = fallback[0] ?? null
          }
          bankConfigCache.set(cacheKey, row)
          return row
        }

        // The bank logo bytes, fetched once per master reference via the
        // AssetStore. renderCollateralPdf embeds a PNG/JPG and degrades a
        // non-embeddable (.ai) master to a text placeholder itself (P4-D3).
        const logoCache = new Map<string, { bytes: Uint8Array; contentType: string } | null>()
        async function logoFor(ref: string | null): Promise<{ bytes: Uint8Array; contentType: string } | null> {
          if (ref === null) return null
          if (logoCache.has(ref)) return logoCache.get(ref) ?? null
          const rec = await assetStore.getByReference(ref)
          const val = rec === null ? null : { bytes: rec.bytes, contentType: rec.meta.contentType }
          logoCache.set(ref, val)
          return val
        }

        for (const e of entries) {
          const cfg = await bankConfigFor(e.bank_reference_code, e.branch_code)
          const bankConfigRef = cfg?.id ?? null
          const logo = await logoFor(cfg?.logo_master_ref ?? null)
          for (const artifactType of artifactTypesFor(e)) {
            // Phase 4 (P4-D4): render the real collateral PDF and store its bytes
            // via the AssetStore, then persist the returned OPAQUE reference on
            // composed_artifact.asset_reference (replacing the old placeholder
            // string). Render + put run INSIDE the onceWithin-guarded compose
            // step, so they execute exactly once per batch even under retry; the
            // in-tx duration is fine for the in-memory adapter, noted as a seam
            // to revisit for the S3 adapter (a batch's worth of renders per tx).
            const pdfBytes = await renderCollateralPdf({
              artifactType,
              qrValue: e.qr_value,
              vpa: e.vpa_value,
              merchantDisplayName: e.merchant_display_name,
              merchantLegalName: e.merchant_legal_name,
              bankName: e.bank_display_name,
              bankCode: e.bank_reference_code,
              imageTemplate: templateFor(cfg?.image_templates, artifactType),
              brandingParams: cfg?.branding_params,
              logo,
            })
            const assetKey = `artifact/${p.btchId}/${e.asgn_id}/${artifactType}`
            const put = await assetStore.put(assetKey, pdfBytes, {
              contentType: 'application/pdf',
              filename: `${artifactType}.pdf`,
            })
            // e.asgn_id is already the native uuid (selected as `::text` off a
            // uuid column, not a wire id), so it is used directly here, NOT
            // re-decoded via toUuid (which expects a wire-form id or a bare
            // 26-char payload and throws on a 36-char uuid string).
            await tx.$executeRaw`
              INSERT INTO composed_artifact (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref)
              VALUES (gen_random_uuid(), ${e.asgn_id}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${artifactType}, ${put.reference}, ${e.merchant_display_name}, ${e.qr_value}, ${bankConfigRef}::uuid)
            `
            composed++
          }
        }
        // Monotonicity guard (dispatch_state: null -> QR_GENERATED ->
        // SENT_TO_VENDOR -> DISPATCHED_BY_VENDOR must never regress): only
        // ever compose an entry from its true starting state, NULL. Without
        // this, a future async consumer that races ahead (e.g. a return-sheet
        // arriving before this step) could have this UPDATE stomp a later
        // state (SENT_TO_VENDOR/DISPATCHED_BY_VENDOR) back down to QR_GENERATED.
        await tx.$executeRaw`
          UPDATE pending_pool_entry SET dispatch_state = 'QR_GENERATED', updated_at = now()
          WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid AND dispatch_state IS NULL
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
