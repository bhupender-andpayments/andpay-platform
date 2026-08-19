import { PDFDocument } from 'pdf-lib'
import { toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { stepKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteScope } from './write-context.js'
import { DISPATCH_TOPIC, dispatchFactEnvelope, type BatchFactPayload } from './events.js'
import { renderCollateralPdf, DEFAULT_SIZE, type ArtifactType } from './collateral/renderer.js'
import type { AssetStore } from './storage/asset-store.js'
import { bankConfigCandidateKeys, selectBankConfig } from './config/bank-config-fallback.js'

// Task 9 (spec section 4.2): thrown when ONE bank_composition_config row
// carries BOTH group masters (soundbox and collateral) and their page boxes
// disagree. setBankTemplateMaster (Task 6) already refuses this at the upload
// door, but a row can predate that gate or be written by hand, so composition
// checks again here, BEFORE any render, as the door check's backstop. The
// message carries only the bank code and branch code (ids and codes, never a
// merchant name, address, or any other PII, S4/S23).
export class TemplateTrimMismatchError extends Error {
  constructor(bankCode: string, branchCode: string | null) {
    super(`template masters disagree on page box for bank ${bankCode} branch ${branchCode ?? ''}`)
    this.name = 'TemplateTrimMismatchError'
  }
}

// which artifacts a snapshot entry gets (from the snapshot alone, C4-safe).
// Task 6 (2026-08-11 dispatch-group split): group-first, same shape as
// package.ts's excelLinesFor. A Task 5 split row's dispatch_group decides its
// artifact set outright: SOUNDBOX renders exactly SOUNDBOX_IMG, COLLATERAL
// renders whichever of STANDEE_IMG/STICKER_IMG the counts call for (an
// all-zero COLLATERAL row is a legitimate orphan and renders nothing at all).
// A null dispatch_group is a legacy, pre-split combined row, and for that row
// alone the original rule keeps deciding, unchanged.
// Exported for the membership contract test (Task 6 review, Important): a
// non-exported function forced the test to assert against a hand-copied twin
// that could silently drift. The export is test-facing only; dispatch.ts
// remains the single implementation.
export function artifactTypesFor(e: {
  dispatch_group: string | null
  soundbox: boolean
  standee_count: number
  sticker_count: number
}): ArtifactType[] {
  if (e.dispatch_group === 'SOUNDBOX') return ['SOUNDBOX_IMG']
  if (e.dispatch_group === 'COLLATERAL') {
    const t: ArtifactType[] = []
    if (e.standee_count > 0) t.push('STANDEE_IMG')
    if (e.sticker_count > 0) t.push('STICKER_IMG')
    return t
  }
  // legacy combined row (pre-split): the original rule, unchanged.
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
  dispatch_group: string | null
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
  logo_derivative_ref: string | null
  soundbox_template_ref: string | null
  collateral_template_ref: string | null
}

// Track B: the DELIVERY GROUP's master for an artifact type. Sticker and
// standee share the collateral master because they share one artwork.
function templateRefFor(cfg: BankConfigRow | null, artifactType: ArtifactType): string | null {
  if (cfg === null) return null
  return artifactType === 'SOUNDBOX_IMG' ? cfg.soundbox_template_ref : cfg.collateral_template_ref
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
             vpa_value, qr_value, bank_reference_code, branch_code, dispatch_group, soundbox, standee_count, sticker_count
      FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    const cfgs = await tx.$queryRaw<BankConfigRow[]>`
      SELECT id::text AS id, bank_code, branch_code, branding_params, image_templates, logo_master_ref,
             logo_derivative_ref, soundbox_template_ref, collateral_template_ref
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

  // ONE shared by-reference cache for every binary asset this phase reads --
  // the bank logo AND, as of Task 9, each group's template master. Both are
  // AssetStore reads keyed on an opaque reference and neither is mutated once
  // stored, so one Map-by-reference cache serves both without drifting into
  // two hand-maintained copies of the same shape.
  const assetCache = new Map<string, { bytes: Uint8Array; contentType: string } | null>()
  async function assetFor(ref: string | null): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (ref === null) return null
    if (assetCache.has(ref)) return assetCache.get(ref) ?? null
    const rec = await assetStore.getByReference(ref)
    const val = rec === null ? null : { bytes: rec.bytes, contentType: rec.meta.contentType }
    assetCache.set(ref, val)
    return val
  }

  // Task 9 preflight (spec 4.2, backstops the Task 6 door check for rows
  // written before that gate existed, or by hand): the parsed page-0 box per
  // reference, cached ALONGSIDE assetFor's byte cache off the SAME map key, so
  // a 300-entry batch still parses each distinct master exactly once no
  // matter how many entries share its config. undefined means "could not be
  // read as a one-page-or-more PDF" and is SKIPPED by the preflight -- an
  // unparseable master is not this check's problem, it degrades to the drawn
  // layout at render time (Task 8's own fallback).
  const boxCache = new Map<string, { w: number; h: number } | undefined>()
  async function boxFor(ref: string): Promise<{ w: number; h: number } | undefined> {
    if (boxCache.has(ref)) return boxCache.get(ref)
    const asset = await assetFor(ref)
    if (asset === null) {
      boxCache.set(ref, undefined)
      return undefined
    }
    const parsed = await PDFDocument.load(asset.bytes).catch(() => null)
    if (parsed === null || parsed.getPageCount() === 0) {
      boxCache.set(ref, undefined)
      return undefined
    }
    const box = { w: parsed.getPage(0).getWidth(), h: parsed.getPage(0).getHeight() }
    boxCache.set(ref, box)
    return box
  }

  // Run once per DISTINCT cfg, before rendering ANY of its entries: the two
  // group masters must agree on EFFECTIVE trim, or the vendor would receive
  // two merged delivery PDFs of unequal size (M2's one-shared-trim guarantee).
  // This whole pass runs BEFORE the render loop below, so a mismatch throws
  // before a single PDF of this batch is rendered or stored, not partway
  // through.
  //
  // WHY effective, not raw refs (fix wave 2, Finding 1): the ORIGINAL version
  // of this check only compared when BOTH template refs were set, and skipped
  // silently otherwise. That let a HALF-CONFIGURED bank through: one group's
  // master uploaded at some trim, the other group's ref left null so its
  // artifacts render at the renderer's hard-coded DEFAULT_SIZE. Nothing here
  // ever compared "the set group's master trim" against "the DEFAULT the
  // unset group actually renders at", so the vendor received two merged PDFs
  // of unequal size, exactly the outcome this whole guarantee exists to
  // prevent. The upload-time door check (ops.ts setBankTemplateMaster) cannot
  // close this alone: it only ever compares against the OTHER group's ref, so
  // a bank's FIRST master at a new trim has nothing yet to disagree with and
  // is correctly accepted there (refusing it would make uploading a first
  // master at a new trim impossible). The row only becomes unsafe once render
  // time asks "what actually prints", which is here, so this is where the
  // effective comparison has to live.
  //
  // The effective box per group is the parsed master page box when its ref is
  // set and parses, else the renderer's own DEFAULT_SIZE (imported, never a
  // second hand-typed copy of the number, so the two can never drift): a bank
  // with NO masters compares DEFAULT against DEFAULT and passes by
  // construction; a bank with one master AT the default trim compares DEFAULT
  // against DEFAULT too (that trim IS the default, not a coincidence) and
  // composes fine with mixed backgrounds; a bank with one master at ANY OTHER
  // trim now fails loudly here instead of shipping the print vendor two
  // unequal-size PDFs.
  const DEFAULT_BOX = { w: DEFAULT_SIZE.widthPt, h: DEFAULT_SIZE.heightPt }
  const seenCfgIds = new Set<string>()
  for (const e of entries) {
    const cfg = cfgFor(e.bank_reference_code, e.branch_code)
    if (cfg === null || seenCfgIds.has(cfg.id)) continue
    seenCfgIds.add(cfg.id)
    const soundboxBox = cfg.soundbox_template_ref === null ? undefined : await boxFor(cfg.soundbox_template_ref)
    const collateralBox = cfg.collateral_template_ref === null ? undefined : await boxFor(cfg.collateral_template_ref)
    const effSoundbox = soundboxBox ?? DEFAULT_BOX
    const effCollateral = collateralBox ?? DEFAULT_BOX
    const widthOff = Math.abs(effSoundbox.w - effCollateral.w) > 0.01
    const heightOff = Math.abs(effSoundbox.h - effCollateral.h) > 0.01
    if (widthOff || heightOff) throw new TemplateTrimMismatchError(cfg.bank_code, cfg.branch_code)
  }

  for (const e of entries) {
    const cfg = cfgFor(e.bank_reference_code, e.branch_code)
    // Prefer the rasterised derivative: the master may be a .ai vector the
    // PDF embedder cannot consume (BRD D.2). Falls back to the master for
    // rows uploaded before the pair flow existed.
    const logo = await assetFor(cfg?.logo_derivative_ref ?? cfg?.logo_master_ref ?? null)
    for (const artifactType of artifactTypesFor(e)) {
      const master = await assetFor(templateRefFor(cfg, artifactType))
      const pdfBytes = await renderCollateralPdf({
        artifactType,
        // The WIRE asgn_ id, printed on the page so the print vendor can
        // reconcile a page in a merged PDF and report an AWB against it.
        // e.asgn_id is the native uuid (selected `::text` off a uuid column),
        // so it converts via the same fromUuid('asgn', ...) this file already
        // uses for the dispatch fact's asgnIds. Deterministic input, so the
        // render stays byte-stable and the re-render on redelivery still
        // matches (see the SAFE TO REPEAT note above).
        dispatchId: fromUuid('asgn', e.asgn_id),
        qrValue: e.qr_value,
        vpa: e.vpa_value,
        merchantDisplayName: e.merchant_display_name,
        merchantLegalName: e.merchant_legal_name,
        bankName: e.bank_display_name,
        bankCode: e.bank_reference_code,
        imageTemplate: templateFor(cfg?.image_templates, artifactType),
        brandingParams: cfg?.branding_params,
        logo,
        // Task 9: only the bytes cross into the renderer (CollateralInput
        // deliberately carries no reference, no key, nothing storage-shaped).
        // A master that failed to resolve (never set, or a stale ref) is
        // null, which is the exact input the drawn layout already treats as
        // "no master" (Task 8).
        templateMaster: master === null ? null : { bytes: master.bytes },
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
            dispatch_group: string | null
            soundbox: boolean
            standee_count: number
            sticker_count: number
          }[]
        >`
          SELECT asgn_id::text AS asgn_id, merchant_display_name, merchant_legal_name, bank_display_name,
                 vpa_value, qr_value, bank_reference_code, branch_code, dispatch_group, soundbox, standee_count, sticker_count
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
          // Task 9: carried here for parity with the pre-render's own
          // BankConfigRow (both declaration sites, one shape), even though
          // this in-transaction lookup only ever needs `id` for
          // bank_config_ref -- the actual masters were already resolved and
          // passed into the renderer by preRenderArtifacts, above, outside
          // this transaction.
          soundbox_template_ref: string | null
          collateral_template_ref: string | null
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
              SELECT id::text AS id, branding_params, image_templates, logo_master_ref,
                     soundbox_template_ref, collateral_template_ref
              FROM bank_composition_config
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

      // THE DISPATCH STEP NO LONGER RUNS HERE (18 Aug 2026, decision D4).
      //
      // Until now, a batch was handed to the print vendor automatically, in
      // this very transaction, the instant it formed. Forming a batch and
      // sending it to a vendor are two different decisions, and the second one
      // belongs to an operator: they may want to look at the QR proofs, wait
      // for stock, or hold a record before the run leaves. So the step moved
      // out to the ops action sendBatchToVendor (ops.ts), which calls
      // sendBatchToVendorWithinTx below.
      //
      // COMPOSE stays automatic and stays here: generating the QR artifacts is
      // pure preparation with no outside effect, and having them ready is what
      // makes the operator's send decision an informed one.
      //
      // The saga_instance legitimately STAYS status='running' (fold correction
      // 4): the dispatch lifecycle does not terminate at compose, and no
      // terminal-completion UPDATE belongs in this function.
    })
  })

  return { deduped: !ran, composed }
}

/**
 * Hand a composed batch to its print vendor: bind the vendor, advance every
 * one of the batch's dispatches to SENT_TO_VENDOR, record the saga step, and
 * emit the dispatch fact.
 *
 * Extracted verbatim from consumeBatchFact's old automatic dispatch step
 * (decision D4, 18 Aug 2026) so that the operator-triggered action in ops.ts
 * performs exactly what the consumer used to, byte for byte, rather than a
 * second implementation that can drift from it. The caller owns the
 * transaction, the write scope, and the idempotency keys; this function is the
 * effect alone.
 *
 * D-9a: THE VENDOR IS BOUND HERE, IN THE CALLER'S TRANSACTION. `print_vndr` was
 * once written by no production path at all, so every vendor pull resolved
 * '__none__' and was scope-denied: a real print vendor with a real credential
 * got a 403 on a real batch, silently, because a NULL column reads as "not
 * mine" rather than as an error.
 *
 * WHICH vendor (ruled by Bhupender 2026-08-09): the single ACTIVE PRINT vendor.
 * The BRD says "the print vendor" throughout, singular, and single-partner
 * scope is ratified, so this invents no config entity and no selection UI.
 *
 * NOT EXACTLY ONE IS A HARD FAILURE, on purpose: advancing with a NULL vendor
 * would leave the batch looking sent while no vendor could ever pull it.
 * Throwing rolls back the caller's whole transaction, dedup rows included, so
 * nothing is marked sent. As a consumer step that meant the retry ladder and
 * eventually the DLQ; as an operator action the caller turns it into a 409 the
 * operator can act on, which is the better surface for what is really a vendor
 * configuration mistake.
 */
export async function sendBatchToVendorWithinTx(
  tx: Tx,
  args: { btchId: string; btchUuid: string; programUuid: string; traceId: string },
): Promise<{ asgnIds: string[] }> {
  // Read the batch FIRST and treat its absence as a fault. A bare conditional
  // UPDATE would have been the natural way to write this, and it hides two
  // different situations behind the same "0 rows affected": already bound (fine,
  // a replay) and no batch row at all (a real bug, and exactly the silent-NULL
  // failure described above). Read, then decide.
  const batchRows = await tx.$queryRaw<{ print_vndr: string | null }[]>`
    SELECT print_vndr::text AS print_vndr FROM batch
    WHERE id = ${args.btchUuid}::uuid AND program_id = ${args.programUuid}::uuid
  `
  if (batchRows.length !== 1) {
    throw new BatchNotFoundError(args.btchId)
  }
  // Already bound means this is a replay. Leave it alone and do NOT re-resolve:
  // a batch a vendor has already pulled must never re-point because the vendor
  // roster changed afterwards.
  if (batchRows[0]!.print_vndr === null) {
    const printVndrs = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM vndr WHERE type = 'PRINT' AND status = 'ACTIVE'
    `
    if (printVndrs.length !== 1) {
      throw new PrintVendorNotResolvableError(args.btchId, printVndrs.length)
    }
    await tx.$executeRaw`
      UPDATE batch SET print_vndr = ${printVndrs[0]!.id}::uuid, updated_at = now()
      WHERE id = ${args.btchUuid}::uuid AND program_id = ${args.programUuid}::uuid AND print_vndr IS NULL
    `
  }
  await tx.$executeRaw`
    INSERT INTO saga_step (instance_id, name, status, attempts, idempotency_key, updated_at)
    VALUES (${args.btchUuid}::uuid, 'dispatch', 'completed', 1, ${stepKey(args.btchId, 'dispatch')}, now())
    ON CONFLICT (instance_id, name) DO NOTHING
  `
  const rows = await tx.$queryRaw<{ asgn_id: string }[]>`
    UPDATE pending_pool_entry SET dispatch_state = 'SENT_TO_VENDOR', updated_at = now()
    WHERE batch = ${args.btchUuid}::uuid AND program_id = ${args.programUuid}::uuid
      AND dispatch_state = 'QR_GENERATED'
    RETURNING asgn_id::text AS asgn_id
  `
  const asgnIds = rows.map((r) => fromUuid('asgn', r.asgn_id))
  await enqueue(tx, {
    aggregateType: 'batch',
    aggregateId: args.btchId,
    eventType: DISPATCH_TOPIC,
    partitionKey: args.btchId,
    payload: dispatchFactEnvelope({
      payload: { btchId: args.btchId, asgnIds, dispatchState: 'SENT_TO_VENDOR' },
      // The dedupKey the consumer used, unchanged, so analytics folds this fact
      // exactly as before and a batch the old automatic step already dispatched
      // can never be double-counted.
      dedupKey: `${args.btchId}|SENT_TO_VENDOR`,
      traceId: args.traceId,
    }),
  })
  return { asgnIds }
}

/** The batch does not exist (or is not in the caller's program scope). */
export class BatchNotFoundError extends Error {
  readonly code = 'batch-not-found'

  constructor(btchId: string) {
    super(`batch ${btchId}: not found, cannot bind a print vendor`)
    this.name = 'BatchNotFoundError'
  }
}

/** Zero or several ACTIVE PRINT vendors: an operator configuration mistake. */
export class PrintVendorNotResolvableError extends Error {
  readonly code = 'print-vendor-not-resolvable'

  constructor(
    btchId: string,
    readonly found: number,
  ) {
    super(`batch ${btchId}: expected exactly 1 ACTIVE PRINT vendor, found ${String(found)}`)
    this.name = 'PrintVendorNotResolvableError'
  }
}
