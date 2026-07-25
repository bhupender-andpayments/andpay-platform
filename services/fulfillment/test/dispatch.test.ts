import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { stepKey } from '@andpay/keys'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { consumeBatchFact } from '../src/dispatch.js'
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

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, composed_artifact, bank_composition_config, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

// LOCAL fixture (fold correction 6): there is no production seed helper for
// bank_composition_config. Keyed on (tenant_id, bank_code), the table's own
// @@unique, with a minimal image_templates JSONB. updated_at is NOT NULL with
// no DB default (no @default(now())), so it is set explicitly here.
async function seedBankConfig(tenantUuid: string, bankCode: string): Promise<string> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO bank_composition_config (
      id, tenant_id, bank_code, logo_master_ref, logo_derivative_ref, branding_params, image_templates, updated_at
    ) VALUES (
      gen_random_uuid(), ${tenantUuid}::uuid, ${bankCode}, 'ref-logo-master', 'ref-logo-derivative',
      '{}'::jsonb, '{"SOUNDBOX":{},"STANDEE":{}}'::jsonb, now()
    )
    RETURNING id::text AS id
  `
  return rows[0]!.id
}

// A fixture pending_pool_entry row, ALREADY BATCHED (pool_status='BATCHED',
// batch=<btchUuid>), the event-carried snapshot consumeBatchFact reads (no
// C4/TMS read). soundbox=true, standee_count=1 so both SOUNDBOX_IMG and
// STANDEE_IMG are composed per entry. Distinct asgn_id/merchant_id per call;
// trace_id is deliberately test-controlled and DIFFERENT per entry (proves
// fold-1: the dispatch facts must use env.traceId, never an entry's trace_id).
async function seedBatchedEntry(
  tenantUuid: string,
  programUuid: string,
  btchUuid: string,
  traceId: string,
  bankCode: string,
): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const merchantUuid = toUuid(newId('mrch'))
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${merchantUuid}::uuid, true, 1, 0, true,
      'Acme', 'Acme Pvt Ltd', '5814', ${bankCode}, 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid, 'file-1|1', ${traceId}, now()
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

    const res = await consumeBatchFact(db, env)
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
    const res2 = await consumeBatchFact(db, env)
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
    const res = await consumeBatchFact(db, env)
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
})
