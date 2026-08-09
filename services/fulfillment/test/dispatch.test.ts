import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { stepKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { consumeBatchFact } from '../src/dispatch.js'
import { InMemoryAssetStore } from '../src/storage/dev-asset-store.js'
import { buildDispatchPackage, assembleTypePdf, dispatchXlsx, AssetResolutionError } from '../src/package.js'
import { PDFDocument } from 'pdf-lib'
import QRCode from 'qrcode'
import { CONSUMER, setProgramContext } from '../src/internal.js'
import {
  DISPATCH_TOPIC,
  batchFactEnvelope,
  dispatchFactEnvelope,
  type DispatchFactPayload,
} from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })
const assetStore = new InMemoryAssetStore()

// D-9a: the dispatch step now BINDS the batch to the single ACTIVE PRINT
// vendor, and fails closed when there is not exactly one, so this suite has to
// establish that precondition. `vndr` is in the TRUNCATE list deliberately:
// without it, an ACTIVE PRINT row left behind by another suite would make it
// two and every test here would fail on a condition it never set up. Seeding a
// fixed id after a truncate makes the count exactly one no matter what ran
// before.
const PRINT_VNDR = 'e1000000-0000-4000-8000-000000000001'

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, bank_composition_config, batch, batch_pool, saga_timer, saga_step, saga_instance, vndr, outbox, inbox CASCADE',
  )
  await db.$executeRawUnsafe(
    `INSERT INTO vndr (id, type, display_name, status, created_at, updated_at)
     VALUES ('${PRINT_VNDR}'::uuid, 'PRINT', 'Dispatch Test Print Vendor', 'ACTIVE', now(), now())`,
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// LOCAL fixture (fold correction 6): there is no production seed helper for
// bank_composition_config. Keyed on (tenant_id, bank_code, branch_code), the
// table's own @@unique (widened Phase 3 Task 5a), with a minimal
// image_templates JSONB. updated_at is NOT NULL with no DB default (no
// @default(now())), so it is set explicitly here. branchCode defaults to the
// '' bank-level-default sentinel (never null, closing the NULL-distinct
// unique-index gotcha); pass an explicit branch code to seed a branch-specific
// row.
async function seedBankConfig(tenantUuid: string, bankCode: string, branchCode = ''): Promise<string> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO bank_composition_config (
      id, tenant_id, bank_code, branch_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at
    ) VALUES (
      gen_random_uuid(), ${tenantUuid}::uuid, ${bankCode}, ${branchCode}, 'ref-logo-master', 'ref-logo-derivative',
      '{}'::jsonb, '{"SOUNDBOX":{},"STANDEE":{}}'::jsonb, now()
    )
    RETURNING id::text AS id
  `
  return rows[0]!.id
}

// The `batch` ROW itself. Production always has one before the batch fact is
// emitted (batching.ts writes it in the same transaction as the fact), but this
// suite never created one, so every UPDATE against it matched zero rows. That
// mattered the moment dispatch started binding print_vndr: the assertions would
// have passed while proving nothing. Idempotent so a test can call it once per
// batch id without caring whether an earlier helper already did.
async function seedBatchRow(tenantUuid: string, programUuid: string, btchUuid: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'BORN', 'LOT_SIZE', 1, now())
    ON CONFLICT (id) DO NOTHING
  `
}

// A fixture pending_pool_entry row, ALREADY BATCHED (pool_status='BATCHED',
// batch=<btchUuid>), the event-carried snapshot consumeBatchFact reads (no
// C4/TMS read). soundbox=true, standee_count=1 so both SOUNDBOX_IMG and
// STANDEE_IMG are composed per entry. Distinct asgn_id/merchant_id per call;
// trace_id is deliberately test-controlled and DIFFERENT per entry (proves
// fold-1: the dispatch facts must use env.traceId, never an entry's trace_id).
// Also seeds the batch row it points at, so the fixture is whole.
async function seedBatchedEntry(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  traceId: string,
  bankCode: string,
  branchCode: string | null = null,
): Promise<{ asgnWire: string; asgnUuid: string }> {
  await seedBatchRow(tenantUuid, programUuid, btchUuid)
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const merchantUuid = toUuid(newId('mrch'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, branch_code, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid, true, 1, 0, true,
      'Acme', 'Acme Pvt Ltd', '5814', ${bankCode}, 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid, 'file-1|1', ${traceId}, ${branchCode}, now()
    )
  `
  return { asgnWire, asgnUuid }
}

interface DispatchOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<DispatchFactPayload>
}

interface ComposedArtifactRow {
  id: string
  asgn_id: string
  btch_id: string
  tenant_id: string
  program_id: string
  artifact_type: string
  asset_reference: string
  label_display_name: string
  label_qr: string
  bank_config_ref: string | null
  created_at: Date
}

describe('consumeBatchFact (dispatch-lifecycle PM: compose + dispatch off the batch fact, checks 1/7/10)', () => {
  it('composes artifacts, advances dispatch_state, emits two IDs-only dispatch facts carrying env.traceId, is idempotent on redelivery, and anchors a saga_instance', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    // TWO bank_composition_config rows, same tenant, DISTINCT bank_code (fold-2
    // hardening): proves the compose lookup keys on the entry's OWN
    // bank_reference_code, not a single tenant-wide row. Entry a stays HDFC;
    // entry b is deliberately batched under a DIFFERENT bank (ICICI) in the
    // SAME batch, which is legitimate (a batch may mix banks).
    const hdfcConfigId = await seedBankConfig(tenantUuid, 'HDFC')
    const iciciConfigId = await seedBankConfig(tenantUuid, 'ICICI')
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-a', 'HDFC')
    const b = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-b', 'ICICI')

    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 2,
        asgnIds: [a.asgnWire, b.asgnWire],
      },
      dedupKey: btchWire,
      traceId: 'trace-batch-1',
    })

    const res = await consumeBatchFact(db, env, assetStore)
    expect(res.deduped).toBe(false)
    expect(res.composed).toBe(4) // 2 entries x (SOUNDBOX_IMG + STANDEE_IMG)

    // composed_artifact: one row per (asgn, artifact_type), snapshot content
    // carried through, and structurally NO shipping-PII column.
    const artifacts = await db.$queryRaw<ComposedArtifactRow[]>`
      SELECT id::text AS id, asgn_id::text AS asgn_id, btch_id::text AS btch_id, tenant_id::text AS tenant_id,
             program_id::text AS program_id, artifact_type, asset_reference, label_display_name, label_qr,
             bank_config_ref::text AS bank_config_ref, created_at
      FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid ORDER BY asgn_id, artifact_type
    `
    expect(artifacts).toHaveLength(4)
    for (const row of artifacts) {
      expect(['SOUNDBOX_IMG', 'STANDEE_IMG']).toContain(row.artifact_type)
      expect(row.label_display_name).toBe('Acme')
      expect(row.label_qr).toBe('upi://pay?pa=acme@hdfcbank')
      expect(row.tenant_id).toBe(tenantUuid)
      expect(row.program_id).toBe(programUuid)
      // no shipping-PII column exists on the row at all (structural, D104: only
      // display name + QR/VPA are entitled here).
      expect(Object.keys(row)).not.toContain('ship_to_address')
      expect(Object.keys(row)).not.toContain('ship_to_contact_name')
      expect(Object.keys(row)).not.toContain('ship_to_mobile')
      // fold-2 hardening: each entry's artifacts reference ITS OWN bank
      // config, never the other bank's. A tenant-wide `LIMIT 1` lookup
      // (the rejected design) would fail this for entry b.
      expect(row.bank_config_ref).not.toBeNull()
      if (row.asgn_id === a.asgnUuid) {
        expect(row.bank_config_ref).toBe(hdfcConfigId)
      } else if (row.asgn_id === b.asgnUuid) {
        expect(row.bank_config_ref).toBe(iciciConfigId)
      } else {
        throw new Error(`unexpected asgn_id on composed_artifact row: ${row.asgn_id}`)
      }
    }
    const asgnsWithArtifacts = new Set(artifacts.map((r) => r.asgn_id))
    expect(asgnsWithArtifacts).toEqual(new Set([a.asgnUuid, b.asgnUuid]))

    // pending_pool_entry advanced all the way to SENT_TO_VENDOR (compose ->
    // QR_GENERATED, then dispatch -> SENT_TO_VENDOR).
    const entries = await db.$queryRaw<{ asgn_id: string; dispatch_state: string | null }[]>`
      SELECT asgn_id::text AS asgn_id, dispatch_state FROM pending_pool_entry WHERE batch = ${btchUuid}::uuid
    `
    expect(entries).toHaveLength(2)
    for (const row of entries) {
      expect(row.dispatch_state).toBe('SENT_TO_VENDOR')
    }

    // exactly two fct.fulfillment.dispatch.v1 outbox rows: QR_GENERATED and
    // SENT_TO_VENDOR, BOTH carrying env.traceId (fold 1: 'trace-batch-1', NOT
    // 'trace-a'/'trace-b'), IDs-only payloads.
    const outbox = await db.$queryRaw<DispatchOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${DISPATCH_TOPIC} ORDER BY created_at
    `
    expect(outbox).toHaveLength(2)
    const byState = new Map(outbox.map((o) => [o.payload.payload.dispatchState, o]))
    expect(new Set(byState.keys())).toEqual(new Set(['QR_GENERATED', 'SENT_TO_VENDOR']))
    for (const row of outbox) {
      expect(row.partition_key).toBe(btchWire)
      expect(row.payload.traceId).toBe('trace-batch-1')
      expect(row.payload.payload.btchId).toBe(btchWire)
      expect(new Set(row.payload.payload.asgnIds)).toEqual(new Set([a.asgnWire, b.asgnWire]))
      // IDs-only (S7): no label content, no PII keys on the payload.
      expect(Object.keys(row.payload.payload).sort()).toEqual(['asgnIds', 'btchId', 'dispatchState'])
    }

    // saga_instance anchor for the dispatch_lifecycle flow.
    const instances = await db.$queryRaw<{ id: string; flow_type: string; status: string }[]>`
      SELECT id::text AS id, flow_type, status FROM saga_instance WHERE id = ${btchUuid}::uuid
    `
    expect(instances).toHaveLength(1)
    expect(instances[0]!.flow_type).toBe('dispatch_lifecycle')
    expect(instances[0]!.status).toBe('running') // fold 4: stays running (event-driven wait)

    // fold-3 hardening: each saga_step's idempotency_key is the wire-form
    // stepKey(btchWire, <name>), NOT stepKey(btchUuid, <name>) or any other
    // uuid form. This fails if the key regresses to the uuid form.
    const composeStep = await db.$queryRaw<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM saga_step WHERE instance_id = ${btchUuid}::uuid AND name = 'compose'
    `
    expect(composeStep).toHaveLength(1)
    expect(composeStep[0]!.idempotency_key).toBe(stepKey(btchWire, 'compose'))

    const dispatchStep = await db.$queryRaw<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM saga_step WHERE instance_id = ${btchUuid}::uuid AND name = 'dispatch'
    `
    expect(dispatchStep).toHaveLength(1)
    expect(dispatchStep[0]!.idempotency_key).toBe(stepKey(btchWire, 'dispatch'))

    // redelivery of the SAME envelope (same dedupKey) is a no-op.
    const res2 = await consumeBatchFact(db, env, assetStore)
    expect(res2.deduped).toBe(true)

    const artifactsAfter = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid
    `
    expect(Number(artifactsAfter[0]!.n)).toBe(4) // stable, no duplicate composition

    const outboxAfter = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${DISPATCH_TOPIC}
    `
    expect(Number(outboxAfter[0]!.n)).toBe(2) // no new outbox rows
  })

  // E1 (check 10, compose half): the compose effect's composed_artifact
  // INSERTs and its dispatch-fact enqueue must commit or roll back TOGETHER
  // with the inbox dedup row. As with the spec-07 batching.ts E1 precedent,
  // wrapping a call to consumeBatchFact in an outer transaction that throws
  // afterward proves nothing (consumeBatchFact opens its OWN top-level
  // db.$transaction, already committed by the time an outer wrapper's throw
  // runs). Replicate the exact compose write sequence inside ONE transaction
  // this test controls, force a throw after all of it has run, and assert
  // composed_artifact and the dispatch outbox are BOTH empty; then prove the
  // positive direction with a real consumeBatchFact call, reusing the SAME
  // dedupKey (nothing was burned by the rollback: the inbox row rolled back
  // too).
  it('E1: compose writes (composed_artifact + dispatch-fact enqueue) commit or roll back together with the inbox row', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    await seedBankConfig(tenantUuid, 'HDFC')
    const entry = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-e1', 'HDFC')

    const dedupKey = btchWire

    await expect(
      db.$transaction(async (tx) => {
        await onceWithin(tx, CONSUMER, dedupKey, async () => {
          await tx.$executeRaw`
            INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
            VALUES (${btchUuid}::uuid, 'dispatch_lifecycle', 1, 'running', now())
            ON CONFLICT (id) DO NOTHING
          `
          await setProgramContext(tx, programUuid)
          await onceWithin(tx, CONSUMER, `${btchWire}|compose`, async () => {
            await tx.$executeRaw`
              INSERT INTO saga_step (instance_id, name, status, attempts, idempotency_key, updated_at)
              VALUES (${btchUuid}::uuid, 'compose', 'completed', 1, ${stepKey(btchWire, 'compose')}, now())
              ON CONFLICT (instance_id, name) DO NOTHING
            `
            await tx.$executeRaw`
              INSERT INTO composed_artifact (
                id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference,
                label_display_name, label_qr, bank_config_ref
              ) VALUES (
                gen_random_uuid(), ${entry.asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid,
                ${programUuid}::uuid, 'SOUNDBOX_IMG', 'ref', 'Acme', 'acme@hdfcbank', ${null}::uuid
              )
            `
            await tx.$executeRaw`
              UPDATE pending_pool_entry SET dispatch_state = 'QR_GENERATED', updated_at = now()
              WHERE batch = ${btchUuid}::uuid AND program_id = ${programUuid}::uuid
            `
            await enqueue(tx, {
              aggregateType: 'batch',
              aggregateId: btchWire,
              eventType: DISPATCH_TOPIC,
              partitionKey: btchWire,
              payload: dispatchFactEnvelope({
                payload: { btchId: btchWire, asgnIds: [entry.asgnWire], dispatchState: 'QR_GENERATED' },
                dedupKey: `${btchWire}|QR_GENERATED`,
                traceId: 'trace-batch-e1',
              }),
            })
          })
        })
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const c0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact`
    const o0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${DISPATCH_TOPIC}`
    const i0 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inbox`
    expect(Number(c0[0]!.n)).toBe(0) // the composed_artifact INSERT rolled back
    expect(Number(o0[0]!.n)).toBe(0) // the enqueue rolled back WITH it (E1)
    expect(Number(i0[0]!.n)).toBe(0) // the inbox insert rolled back too

    const entryAfterRollback = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${entry.asgnUuid}::uuid
    `
    expect(entryAfterRollback[0]!.dispatch_state).toBeNull() // NOT advanced

    // positive direction: a real consumeBatchFact commits everything, reusing
    // the SAME dedupKey as the rolled-back attempt (nothing was burned).
    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 1,
        asgnIds: [entry.asgnWire],
      },
      dedupKey,
      traceId: 'trace-batch-e1-real',
    })
    const res = await consumeBatchFact(db, env, assetStore)
    expect(res.deduped).toBe(false)
    expect(res.composed).toBe(2) // soundbox + standee

    const c1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact`
    const o1 = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox WHERE event_type = ${DISPATCH_TOPIC}`
    expect(Number(c1[0]!.n)).toBe(2)
    expect(Number(o1[0]!.n)).toBe(2)

    const entryAfterReal = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${entry.asgnUuid}::uuid
    `
    expect(entryAfterReal[0]!.dispatch_state).toBe('SENT_TO_VENDOR')
  })

  // Phase 3 Task 5a: bankConfigRefFor's branch-aware fallback order (mirrors
  // the multi-bank test above, one batch, THREE entries under the SAME bank
  // code HDFC but different branch situations):
  //   entry a (branch BR-001) has an exact branch-specific config row -> resolves to it.
  //   entry b (branch BR-002) has NO branch-specific row, only the bank-level
  //     default ('' sentinel) -> falls back to the bank-level default row.
  //   entry c (branch BR-003) has NEITHER a branch row NOR a bank-level
  //     default for its bank (ICICI) -> resolves null (current no-branding
  //     behavior).
  it('Task 5a: bankConfigRefFor resolves branch-exact -> bank-level-default -> null, in that order', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)

    // HDFC gets both a branch-specific row (BR-001) AND its bank-level
    // default ('' sentinel). ICICI gets NEITHER.
    const hdfcBranchConfigId = await seedBankConfig(tenantUuid, 'HDFC', 'BR-001')
    const hdfcDefaultConfigId = await seedBankConfig(tenantUuid, 'HDFC', '')

    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-a', 'HDFC', 'BR-001')
    const b = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-b', 'HDFC', 'BR-002')
    const c = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-c', 'ICICI', 'BR-003')

    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 3,
        asgnIds: [a.asgnWire, b.asgnWire, c.asgnWire],
      },
      dedupKey: btchWire,
      traceId: 'trace-batch-5a',
    })

    const res = await consumeBatchFact(db, env, assetStore)
    expect(res.deduped).toBe(false)

    const artifacts = await db.$queryRaw<{ asgn_id: string; bank_config_ref: string | null }[]>`
      SELECT asgn_id::text AS asgn_id, bank_config_ref::text AS bank_config_ref
      FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid AND artifact_type = 'SOUNDBOX_IMG'
    `
    const byAsgn = new Map(artifacts.map((r) => [r.asgn_id, r.bank_config_ref]))
    expect(byAsgn.get(a.asgnUuid)).toBe(hdfcBranchConfigId) // exact branch match
    expect(byAsgn.get(b.asgnUuid)).toBe(hdfcDefaultConfigId) // falls back to the bank-level default
    expect(byAsgn.get(c.asgnUuid)).toBeNull() // neither exists -> null (no-branding)
  })

  it('P4-2: composition stores a real PDF per artifact via the AssetStore and persists its reference (not the placeholder)', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    await seedBankConfig(tenantUuid, 'HDFC')
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-a', 'HDFC')
    const env = batchFactEnvelope({
      payload: { btchId: btchWire, tenantId: tenantWire, programId: programWire, triggerReason: 'LOT_SIZE', unitCount: 1, asgnIds: [a.asgnWire] },
      dedupKey: btchWire,
      traceId: 'trace-batch-p42',
    })

    const res = await consumeBatchFact(db, env, assetStore)
    expect(res.composed).toBe(2) // soundbox=true + standee_count=1 -> SOUNDBOX_IMG + STANDEE_IMG

    const arts = await db.$queryRaw<{ asset_reference: string }[]>`
      SELECT asset_reference FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid
    `
    expect(arts).toHaveLength(2)
    for (const art of arts) {
      // the old synthetic placeholder is gone; the reference resolves to real PDF bytes
      expect(art.asset_reference.startsWith('s3://')).toBe(false)
      const rec = await assetStore.getByReference(art.asset_reference)
      expect(rec).not.toBeNull()
      const bytes = rec!.bytes
      expect(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d).toBe(true) // %PDF-
      expect(rec!.meta.contentType).toBe('application/pdf')
    }
  })

  it('P4-2: a real PNG logo master is fetched and embedded, the reference chain still resolves to a valid PDF', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    // put a real PNG under a master ref, then point a bank config at it
    const pngLogo = await QRCode.toBuffer('logo', { type: 'png', width: 64 })
    const put = await assetStore.put('logo/HDFC', new Uint8Array(pngLogo), { contentType: 'image/png', filename: 'hdfc.png' })
    await db.$executeRaw`
      INSERT INTO bank_composition_config (id, tenant_id, bank_code, branch_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at)
      VALUES (gen_random_uuid(), ${tenantUuid}::uuid, 'HDFC', '', ${put.reference}, NULL, '{}'::jsonb, '{}'::jsonb, now())
    `
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-logo', 'HDFC')
    const env = batchFactEnvelope({
      payload: { btchId: btchWire, tenantId: tenantWire, programId: programWire, triggerReason: 'LOT_SIZE', unitCount: 1, asgnIds: [a.asgnWire] },
      dedupKey: btchWire,
      traceId: 'trace-logo',
    })
    await consumeBatchFact(db, env, assetStore)
    const arts = await db.$queryRaw<{ asset_reference: string }[]>`SELECT asset_reference FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid`
    expect(arts.length).toBeGreaterThan(0)
    for (const art of arts) {
      const rec = await assetStore.getByReference(art.asset_reference)
      expect(rec).not.toBeNull()
      expect(rec!.bytes[0]).toBe(0x25) // %  -> valid PDF even with the logo embedded
    }
  })

  it('P4-3: dispatch package is bank+branch sorted; assembleTypePdf merges stored PDFs per type (soundbox-only), null when absent', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    // two banks in ONE batch, seeded out of order, to prove the sort
    await seedBankConfig(tenantUuid, 'ZBANK')
    await seedBankConfig(tenantUuid, 'ABANK')
    const z = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-z', 'ZBANK')
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-a', 'ABANK')
    const env = batchFactEnvelope({
      payload: { btchId: btchWire, tenantId: tenantWire, programId: programWire, triggerReason: 'LOT_SIZE', unitCount: 2, asgnIds: [z.asgnWire, a.asgnWire] },
      dedupKey: btchWire,
      traceId: 'trace-p43',
    })
    await consumeBatchFact(db, env, assetStore)

    // sorted: ABANK before ZBANK
    const lines = await buildDispatchPackage(db, btchWire, 'print')
    expect(lines.map((l) => l.bankReferenceCode)).toEqual(['ABANK', 'ZBANK'])

    // soundbox-only merged PDF = one page per entry (both entries have SOUNDBOX_IMG)
    const soundboxPdf = await assembleTypePdf(db, assetStore, btchWire, 'SOUNDBOX_IMG')
    expect(soundboxPdf).not.toBeNull()
    expect((await PDFDocument.load(soundboxPdf!)).getPageCount()).toBe(2)

    // sticker_count is 0 in the seed, so there is no STICKER_IMG artifact -> null
    expect(await assembleTypePdf(db, assetStore, btchWire, 'STICKER_IMG')).toBeNull()

    // the sorted dispatch Excel is a real PK zip
    const xlsx = await dispatchXlsx(lines)
    expect(xlsx.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('P4-3: a composed_artifact whose stored asset does NOT resolve is a FAULT (AssetResolutionError), never a silent empty', async () => {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-fault', 'HDFC')
    // a composed_artifact row referencing an asset that is NOT in the store
    await db.$executeRaw`
      INSERT INTO composed_artifact (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref)
      VALUES (gen_random_uuid(), ${a.asgnUuid}::uuid, ${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'SOUNDBOX_IMG', 'missing-ref-not-in-store', 'Acme', 'upi://x', NULL)
    `
    await expect(assembleTypePdf(db, assetStore, btchWire, 'SOUNDBOX_IMG')).rejects.toBeInstanceOf(AssetResolutionError)
    // a type with NO row is still a legitimate empty (null), not a fault
    expect(await assembleTypePdf(db, assetStore, btchWire, 'STICKER_IMG')).toBeNull()
  })
})

// The property the three-phase refactor trades on, previously reasoned but not
// proven. Rendering and the object-store puts happen OUTSIDE the consume
// transaction, so a crash between them and the commit leaves stored objects
// with no composed_artifact row. That must be orphaned bytes, never corruption
// and never a double-write: the redelivery has to land EXACTLY one set.
describe('crash between the pre-render and the commit (three-phase idempotency)', () => {
  it('a redelivery after a failed consume lands exactly one set of artifacts and one dispatch fact', async () => {
    const tenantWire = newId('tnnt')
    const tenantUuid = toUuid(tenantWire)
    const programWire = newId('prog')
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    await seedBankConfig(tenantUuid, 'HDFC')
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-a', 'HDFC')

    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 1,
        asgnIds: [a.asgnWire],
      },
      dedupKey: btchWire,
      traceId: 'trace-crash-1',
    })

    // Fail the CONSUME transaction specifically, not the pre-render. The
    // pre-render opens the first $transaction (its short read); the consume
    // transaction is the second. Throwing there reproduces the exact window
    // this refactor introduced: assets stored, nothing committed.
    let txCalls = 0
    const crashingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return async (...args: unknown[]) => {
            txCalls += 1
            if (txCalls === 2) throw new Error('simulated crash after pre-render, before commit')
            return (target.$transaction as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as typeof db

    await expect(consumeBatchFact(crashingDb, env, assetStore)).rejects.toThrow(/simulated crash/)

    // NON-VACUITY: the crash must land AFTER the pre-render, otherwise this
    // test proves nothing about the window it claims to cover. The objects are
    // in the store, keyed deterministically, with no row referencing them.
    // Without this assertion a crash on the pre-render's own read transaction
    // would satisfy every other expectation here.
    const orphanA = await assetStore.getCurrent(`artifact/${btchWire}/${a.asgnUuid}/SOUNDBOX_IMG`)
    const orphanB = await assetStore.getCurrent(`artifact/${btchWire}/${a.asgnUuid}/STANDEE_IMG`)
    expect(orphanA, 'the pre-render must have stored objects before the crash').not.toBeNull()
    expect(orphanB).not.toBeNull()

    // Nothing committed: the objects exist but the batch left no trace in the DB.
    const afterCrash = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid`
    expect(Number(afterCrash[0]!.n)).toBe(0)

    // The redelivery. Same envelope, same dedupKey, as an at-least-once rail
    // would deliver it.
    const res = await consumeBatchFact(db, env, assetStore)
    expect(res.deduped).toBe(false)
    expect(res.composed).toBe(2) // SOUNDBOX_IMG + STANDEE_IMG for the one entry

    // EXACTLY one set: the re-render wrote identical bytes to the same
    // deterministic asset key, so no duplicate rows and no second fact.
    const rows = await db.$queryRaw<{ artifact_type: string; asset_reference: string }[]>`
      SELECT artifact_type, asset_reference FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid ORDER BY artifact_type
    `
    expect(rows.map((r) => r.artifact_type)).toEqual(['SOUNDBOX_IMG', 'STANDEE_IMG'])
    expect(new Set(rows.map((r) => r.asset_reference)).size).toBe(2)

    const facts = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${DISPATCH_TOPIC} AND aggregate_id = ${btchWire}
        AND payload->'payload'->>'dispatchState' = 'QR_GENERATED'
    `
    expect(Number(facts[0]!.n)).toBe(1)

    // And a THIRD delivery is a clean no-op, so the guard did not merely
    // survive the crash, it still dedupes normally afterwards.
    const third = await consumeBatchFact(db, env, assetStore)
    expect(third.deduped).toBe(true)
    const finalCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM composed_artifact WHERE btch_id = ${btchUuid}::uuid`
    expect(Number(finalCount[0]!.n)).toBe(2)
  })
})

// D-9a: the dispatch step binds the batch to its print vendor.
//
// The defect this closes was invisible to every existing test: `print_vndr` was
// written by no production code path, so a real print vendor with a real
// credential got a 403 on a real batch, and a NULL column reads as "not mine"
// rather than as an error. These tests assert the binding itself AND the thing
// the binding is FOR, which is that the vendor read can now reach the batch.
describe('D-9a: dispatch binds the batch to the single ACTIVE PRINT vendor', () => {
  async function dispatchOneBatch(): Promise<{ btchWire: string; btchUuid: string; programUuid: string }> {
    const tenantWire = newId('tnnt')
    const programWire = newId('prog')
    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const btchWire = newId('btch')
    const btchUuid = toUuid(btchWire)
    await seedBankConfig(tenantUuid, 'HDFC')
    const a = await seedBatchedEntry(tenantUuid, programUuid, btchUuid, 'trace-pv', 'HDFC')
    const env = batchFactEnvelope({
      payload: {
        btchId: btchWire,
        tenantId: tenantWire,
        programId: programWire,
        triggerReason: 'LOT_SIZE',
        unitCount: 1,
        asgnIds: [a.asgnWire],
      },
      dedupKey: btchWire,
      traceId: 'trace-pv',
    })
    await consumeBatchFact(db, env, assetStore)
    return { btchWire, btchUuid, programUuid }
  }

  async function printVndrOf(btchUuid: string): Promise<string | null> {
    const rows = await db.$queryRaw<{ print_vndr: string | null }[]>`
      SELECT print_vndr::text AS print_vndr FROM batch WHERE id = ${btchUuid}::uuid
    `
    return rows[0]?.print_vndr ?? null
  }

  it('binds the batch to the one ACTIVE PRINT vendor', async () => {
    const { btchUuid } = await dispatchOneBatch()
    expect(await printVndrOf(btchUuid)).toBe(PRINT_VNDR)
  })

  it('makes the batch REACHABLE by that vendor under the vendor-read role', async () => {
    // The point of the whole task. Before the binding, this select returned
    // nothing for every vendor, which is exactly why the live pull 403'd: the
    // RLS predicate is `print_vndr = app.vndr_id`, and NULL never matches.
    const { btchUuid } = await dispatchOneBatch()
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_vendor_read')
      await tx.$queryRaw`SELECT set_config('app.vndr_id', ${PRINT_VNDR}, true)`
      return tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM batch`
    })
    expect(seen.map((r) => r.id)).toEqual([btchUuid])
  })

  it('FAILS CLOSED with no active print vendor: nothing is marked sent to vendor', async () => {
    // Fail closed rather than advance with a NULL vendor, which would leave a
    // batch looking dispatched while no vendor could ever pull it.
    await db.$executeRawUnsafe('TRUNCATE vndr CASCADE')
    await expect(dispatchOneBatch()).rejects.toThrow(/expected exactly 1 ACTIVE PRINT vendor, found 0/)
    const states = await db.$queryRaw<{ dispatch_state: string | null }[]>`
      SELECT dispatch_state FROM pending_pool_entry
    `
    // The whole transaction rolled back, so the entry never reached
    // SENT_TO_VENDOR and no dispatch fact was enqueued.
    expect(states.every((s) => s.dispatch_state !== 'SENT_TO_VENDOR')).toBe(true)
    const facts = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox
      WHERE event_type = ${DISPATCH_TOPIC} AND payload->'payload'->>'dispatchState' = 'SENT_TO_VENDOR'
    `
    expect(Number(facts[0]!.n)).toBe(0)
  })

  it('FAILS CLOSED with two active print vendors, rather than guessing', async () => {
    await db.$executeRawUnsafe(
      `INSERT INTO vndr (id, type, display_name, status, created_at, updated_at)
       VALUES ('e1000000-0000-4000-8000-000000000002'::uuid, 'PRINT', 'Second Print Vendor', 'ACTIVE', now(), now())`,
    )
    await expect(dispatchOneBatch()).rejects.toThrow(/expected exactly 1 ACTIVE PRINT vendor, found 2/)
  })

  it('counts only ACTIVE vendors, so a SUSPENDED one is not eligible', async () => {
    // Proves the status filter is load-bearing: with a suspended second vendor
    // the count is still 1 and dispatch proceeds.
    await db.$executeRawUnsafe(
      `INSERT INTO vndr (id, type, display_name, status, created_at, updated_at)
       VALUES ('e1000000-0000-4000-8000-000000000003'::uuid, 'PRINT', 'Suspended Print Vendor', 'SUSPENDED', now(), now())`,
    )
    const { btchUuid } = await dispatchOneBatch()
    expect(await printVndrOf(btchUuid)).toBe(PRINT_VNDR)
  })

  it('counts only PRINT vendors, so a COURIER or MANUFACTURER is not eligible', async () => {
    // Proves the type filter is load-bearing. A courier vendor is deliberately
    // excluded from artifact pull entirely (105d), so it must never be bound.
    await db.$executeRawUnsafe(
      `INSERT INTO vndr (id, type, display_name, status, created_at, updated_at)
       VALUES ('e1000000-0000-4000-8000-000000000004'::uuid, 'COURIER', 'A Courier', 'ACTIVE', now(), now()),
              ('e1000000-0000-4000-8000-000000000005'::uuid, 'MANUFACTURER', 'A Manufacturer', 'ACTIVE', now(), now())`,
    )
    const { btchUuid } = await dispatchOneBatch()
    expect(await printVndrOf(btchUuid)).toBe(PRINT_VNDR)
  })

  it('a replay does NOT re-point a batch that is already bound', async () => {
    // A vendor may already have pulled this batch. Re-pointing it because the
    // roster changed afterwards would move work under someone's feet.
    const { btchUuid, programUuid } = await dispatchOneBatch()
    expect(await printVndrOf(btchUuid)).toBe(PRINT_VNDR)
    await db.$executeRawUnsafe('TRUNCATE vndr CASCADE')
    await db.$executeRawUnsafe(
      `INSERT INTO vndr (id, type, display_name, status, created_at, updated_at)
       VALUES ('e1000000-0000-4000-8000-000000000006'::uuid, 'PRINT', 'A Different Print Vendor', 'ACTIVE', now(), now())`,
    )
    // Drive the dispatch step directly against the SAME batch, bypassing the
    // envelope dedup, to prove the guard is the print_vndr IS NULL check and
    // not merely onceWithin.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fulfillment_write')
      await tx.$queryRaw`SELECT set_config('app.program_id', ${programUuid}, true)`
      await tx.$executeRaw`
        UPDATE batch SET print_vndr = 'e1000000-0000-4000-8000-000000000006'::uuid
        WHERE id = ${btchUuid}::uuid AND print_vndr IS NULL
      `
    })
    expect(await printVndrOf(btchUuid)).toBe(PRINT_VNDR)
  })
})
