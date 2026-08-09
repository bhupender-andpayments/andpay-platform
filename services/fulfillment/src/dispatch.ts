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
import { bankConfigCandidateKeys, selectBankConfig } from './config/bank-config-fallback.js'

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

// The shape composition reads. Hoisted to module scope so the pre-render phase
// and the in-transaction insert loop share ONE definition and cannot drift.
interface ComposeEntry {
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
}

interface BankConfigRow {
  id: string
  bank_code: string
  branch_code: string | null
  branding_params: unknown
  image_templates: unknown
  logo_master_ref: string | null
}

// ---------------------------------------------------------------------------
// PRE-RENDER: the expensive work, deliberately OUTSIDE any transaction.
//
// Composition used to render every PDF and push every object to the AssetStore
// INSIDE the consume transaction. That is CPU and object-store I/O holding a
// Postgres connection open, and at real volume it does not merely run slowly,
// it FAILS: the first real GSCB batch is 360 rows / 857 artifacts and blew
// Prisma's 5s interactive-transaction default, so the whole batch fact
// dead-lettered, no dispatch fact was ever emitted, and the failure surfaced
// three hops away as an ops user unable to activate a delivered device.
//
// Raising the timeout was rejected as the fix: it pins a connection for minutes
// while rendering, blocks vacuum, and scales linearly with file size. Instead
// the slow work moves out, and the transaction keeps ONLY fast inserts.
//
// SAFE TO REPEAT. Rendering is deterministic (renderCollateralPdf takes no
// clock and no randomness) and the asset key is deterministic, so a redelivery
// re-renders identical bytes to the same key. A crash between this phase and
// the commit leaves stored objects with no composed_artifact row: orphaned
// bytes, never corruption, and the E6 guard makes the retry land exactly one
// set of rows. That is the one property this refactor trades away, and it is
// the right trade against holding a transaction open for minutes.
interface PreparedArtifact {
  reference: string
}

async function preRenderArtifacts(
  db: FulfillmentDb,
  assetStore: AssetStore,
  p: BatchFactPayload,
  btchUuid: string,
  programUuid: string,
): Promise<Map<string, PreparedArtifact>> {
  const prepared = new Map<string, PreparedArtifact>()

  // A SHORT read transaction: enter the same scope the write path uses so RLS
  // sees the same predicate, read what composition needs, and get out.
  const { entries, configs } = await db.$transaction(async (tx: Tx) => {
    await enterWriteScope(tx, 'fulfillment_write', programUuid)
    const rows = await tx.$queryRaw<ComposeEntry[]>`
      SELECT asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name, bank_display_name,
             vpa_value, qr_value, bank_reference_code, branch_code, soundbox, standee_count, sticker_count
      FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    const cfgs = await tx.$queryRaw<BankConfigRow[]>`
      SELECT id::text AS id, bank_code, branch_code, branding_params, image_templates, logo_master_ref
      FROM bank_composition_config
    `
    return { entries: rows, configs: cfgs }
  })
  if (entries.length === 0) return prepared

  // Same fallback the in-transaction lookup uses, and now literally the same
  // rule rather than a second hand-maintained copy of it: an exact branch
  // match, then the bank-level '' sentinel row, then the tenant-level default
  // ('' bank AND '' branch, D-3), then null.
  const byKey = new Map<string, BankConfigRow>()
  for (const c of configs) byKey.set(`${c.bank_code}|${c.branch_code ?? ''}`, c)
  const cfgFor = (bankCode: string, branchCode: string | null): BankConfigRow | null =>
    selectBankConfig(byKey, bankCode, branchCode)

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
    const cfg = cfgFor(e.bank_reference_code, e.branch_code)
    const logo = await logoFor(cfg?.logo_master_ref ?? null)
    for (const artifactType of artifactTypesFor(e)) {
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
      prepared.set(`${e.asgn_id}|${artifactType}`, { reference: put.reference })
    }
  }
  return prepared
}

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

  // Phase 1+2, OUTSIDE any transaction: read what composition needs, render
  // every PDF, and store every object. See preRenderArtifacts for why this must
  // not happen inside the transaction below. Safe to repeat: deterministic
  // render, deterministic asset key.
  const prepared = await preRenderArtifacts(db, assetStore, p, btchUuid, programUuid)

  // Phase 3: the transaction now performs ONLY fast inserts, so the
  // composed_artifact rows and the dispatch fact still commit together (E1)
  // and every onceWithin guard is unchanged (E6).
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
          // Rungs in precedence order, stopping at the first hit. The keys come
          // from the shared rule so this can never drift from the compose-path
          // lookup above, and a rung is only queried when it is distinct (a
          // branch-less entry does not probe branch_code = '' twice).
          for (const key of bankConfigCandidateKeys(bankCode, branchCode)) {
            const hit = await tx.$queryRaw<BankConfigRow[]>`
              SELECT id::text AS id, branding_params, image_templates, logo_master_ref FROM bank_composition_config
              WHERE tenant_id = ${tenantUuid}::uuid AND bank_code = ${key.bankCode} AND branch_code = ${key.branchCode}
            `
            row = hit[0] ?? null
            if (row !== null) break
          }
          bankConfigCache.set(cacheKey, row)
          return row
        }

        // ONE multi-row insert, not one round trip per artifact. After the
        // render moved out of the transaction, 857 sequential INSERTs became
        // the new bottleneck on their own (~30s, still over the 5s default):
        // the cost was never only the PDFs, it was also the chatter. Building
        // the rows first and inserting once keeps the transaction to a single
        // statement.
        const artifactRows: {
          asgnId: string
          btchId: string
          tenantId: string
          programId: string
          artifactType: string
          assetReference: string
          labelDisplayName: string
          labelQr: string
          bankConfigRef: string | null
        }[] = []
        for (const e of entries) {
          const cfg = await bankConfigFor(e.bank_reference_code, e.branch_code)
          const bankConfigRef = cfg?.id ?? null
          for (const artifactType of artifactTypesFor(e)) {
            // The bytes were rendered and stored BEFORE this transaction
            // opened; only the opaque reference is persisted here. A missing
            // entry is a real bug, not something to paper over with a
            // placeholder, so it throws and the batch rolls back.
            const pre = prepared.get(`${e.asgn_id}|${artifactType}`)
            if (pre === undefined) {
              throw new Error(`pre-render missing for ${e.asgn_id}|${artifactType}`)
            }
            artifactRows.push({
              asgnId: e.asgn_id,
              btchId: btchUuid,
              tenantId: tenantUuid,
              programId: programUuid,
              artifactType,
              assetReference: pre.reference,
              labelDisplayName: e.merchant_display_name,
              labelQr: e.qr_value,
              bankConfigRef,
            })
            composed++
          }
        }
        if (artifactRows.length > 0) {
          await tx.composedArtifact.createMany({ data: artifactRows })
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
        // D-9a: BIND THE BATCH TO ITS PRINT VENDOR, HERE, IN THIS TRANSACTION.
        //
        // This step is the one BRD 5.4 describes as making the package
        // available to the print vendor, and it is where records become
        // "Sent to Print Vendor". Until now it did the second half only:
        // `batch.print_vndr` was written by NO production code path, so every
        // vendor pull resolved `'__none__'` and was scope-denied. Measured
        // live: a real print vendor, with a real credential, got a 403 on a
        // real batch. The whole vendor-facing half of the pipeline was
        // unreachable, silently, because a NULL column reads as "not mine"
        // rather than as an error.
        //
        // WHICH vendor (ruled by Bhupender 2026-08-09): the single ACTIVE
        // PRINT vendor. The BRD says "the print vendor" throughout, singular,
        // and describes dispatch as automatic on trigger, and single-partner
        // scope is ratified. So this invents no config entity and no selection
        // UI; it reads what is already there.
        //
        // NOT EXACTLY ONE IS A HARD FAILURE, on purpose. Advancing with a NULL
        // vendor is precisely the bug above: the batch would look dispatched
        // while no vendor could ever pull it. Throwing rolls back this whole
        // transaction, including the inbox dedup, so nothing is marked sent.
        // The fact then rides the normal retry ladder and, if the
        // misconfiguration persists, lands in the DLQ, which is visible and
        // replayable. That is the platform's standard poison path and it is
        // the right one here: zero or several active print vendors is an
        // operator configuration error, not something to paper over per batch.
        // Read the batch FIRST, and treat its absence as a fault. A bare
        // conditional UPDATE would have been the natural way to write this and
        // it hides two different situations behind the same "0 rows affected":
        // already bound (fine, a replay) and NO BATCH ROW AT ALL (a real bug,
        // and exactly the silent-NULL failure this task exists to fix). Read,
        // then decide.
        const batchRows = await tx.$queryRaw<{ print_vndr: string | null }[]>`
          SELECT print_vndr::text AS print_vndr FROM batch
          WHERE id = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
        `
        if (batchRows.length !== 1) {
          throw new Error(`dispatch ${p.btchId}: batch row not found, cannot bind a print vendor`)
        }
        // Already bound means this is a replay. Leave it alone and do NOT
        // re-resolve: a batch a vendor has already pulled must never re-point
        // because the vendor roster changed afterwards.
        if (batchRows[0]!.print_vndr === null) {
          const printVndrs = await tx.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM vndr WHERE type = 'PRINT' AND status = 'ACTIVE'
          `
          if (printVndrs.length !== 1) {
            throw new Error(
              `dispatch ${p.btchId}: expected exactly 1 ACTIVE PRINT vendor, found ${String(printVndrs.length)}`,
            )
          }
          await tx.$executeRaw`
            UPDATE batch SET print_vndr = ${printVndrs[0]!.id}::uuid, updated_at = now()
            WHERE id = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid AND print_vndr IS NULL
          `
        }
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
