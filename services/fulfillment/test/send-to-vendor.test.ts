import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { sendBatchToVendor, OpsClientError } from '../src/ops.js'

// THE OPS SEND ACTION ITSELF (23 Aug 2026). dispatch.test.ts covers
// sendBatchToVendorWithinTx, the vendor-binding EFFECT, and its own comment
// has promised since 18 Aug that "the wrapper's own concerns (its client key
// idempotency, its guards, and how it turns these faults into 409s) belong to
// test/send-to-vendor.test.ts". That file did not exist: the four refusal
// codes, the batch.status write, the batch_status_event trail row and the
// deduped replay all shipped untested. This is that file.

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const ACTOR = 'c0000000-0000-4000-8000-00000000000c'
const PRINT_VNDR = 'e1000000-0000-4000-8000-000000000011'

beforeEach(async () => {
  // vndr is truncated and reseeded because sendBatchToVendorWithinTx binds the
  // batch to the SINGLE ACTIVE PRINT vendor and fails closed on zero or two,
  // so a leftover vendor row from another suite would flip these outcomes.
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, unit, shpt, batch, batch_pool, batch_status_event, pool_entry_status_event, saga_step, saga_instance, vndr, outbox, inbox CASCADE',
  )
  await db.$executeRawUnsafe(
    `INSERT INTO vndr (id, type, display_name, status, created_at, updated_at)
     VALUES ('${PRINT_VNDR}'::uuid, 'PRINT', 'Send Test Print Vendor', 'ACTIVE', now(), now())`,
  )
})
afterAll(async () => {
  await db.$disconnect()
})

interface Fixture {
  btchWire: string
  btchUuid: string
  programUuid: string
  asgnWires: string[]
}

/** A BATCHED batch with `count` entries, each at the given dispatch_state. */
async function seedBatch(count: number, dispatchState: string | null = 'QR_GENERATED'): Promise<Fixture> {
  const btchWire = newId('btch')
  const btchUuid = toUuid(btchWire)
  const tenantUuid = toUuid(newId('tnnt'))
  const programUuid = toUuid(newId('prog'))
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'BATCHED', 'MANUAL', ${count}, now())
  `
  // The saga instance the real compose step would have created: the send's
  // saga_step upsert FK-references it.
  await db.$executeRaw`
    INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
    VALUES (${btchUuid}::uuid, 'batch', 1, 'running', now())
  `
  const asgnWires: string[] = []
  for (let i = 0; i < count; i += 1) {
    const asgnWire = newId('asgn')
    asgnWires.push(asgnWire)
    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
      ) VALUES (
        ${toUuid(asgnWire)}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid,
        true, 0, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank',
        '221B Baker Street', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank',
        'BATCHED', ${btchUuid}::uuid, ${dispatchState}, ${`send|${String(i)}`}, 'trace-send', now()
      )
    `
  }
  return { btchWire, btchUuid, programUuid, asgnWires }
}

async function statusOf(btchUuid: string): Promise<string> {
  const rows = await db.$queryRaw<{ status: string }[]>`SELECT status FROM batch WHERE id = ${btchUuid}::uuid`
  return rows[0]!.status
}

async function trailRows(btchUuid: string): Promise<{ status: string; status_source: string }[]> {
  return db.$queryRaw<{ status: string; status_source: string }[]>`
    SELECT status, status_source FROM batch_status_event WHERE batch_id = ${btchUuid}::uuid
  `
}

async function sixEventCount(): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox WHERE payload->>'decision' = 'ALLOW'
  `
  return Number(rows[0]!.n)
}

function send(fx: Fixture, clientKey = `send-${fx.btchWire}`) {
  return sendBatchToVendor(db, {
    btchId: fx.btchWire,
    clientKey,
    actorId: ACTOR,
    actorDisplay: 'ops.admin',
    traceId: 'trace-send',
  })
}

describe('sendBatchToVendor: the operator action, end to end', () => {
  it('sends a ready batch: status, trail row, entry advance, vendor binding, fact and 6e', async () => {
    const fx = await seedBatch(2)

    const result = await send(fx)
    expect(result).toEqual({ deduped: false, sent: true })

    // The batch's own status moved, and the trail recorded WHO and HOW: this
    // trail row is the page's only source of a real sent-at.
    expect(await statusOf(fx.btchUuid)).toBe('SENT_TO_PRINT_VENDOR')
    const trail = await trailRows(fx.btchUuid)
    expect(trail).toEqual([{ status: 'SENT_TO_PRINT_VENDOR', status_source: 'ops:send-to-vendor' }])

    // Every QR_GENERATED entry advanced.
    const states = await db.$queryRaw<{ dispatch_state: string }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE batch = ${fx.btchUuid}::uuid
    `
    expect(states.map((s) => s.dispatch_state)).toEqual(['SENT_TO_VENDOR', 'SENT_TO_VENDOR'])

    // D-9a: bound to the single ACTIVE PRINT vendor in the same transaction.
    const bound = await db.$queryRaw<{ print_vndr: string | null }[]>`
      SELECT print_vndr::text AS print_vndr FROM batch WHERE id = ${fx.btchUuid}::uuid
    `
    expect(bound[0]!.print_vndr).toBe(PRINT_VNDR)

    // The dispatch fact and the ALLOW 6e co-committed with the effect.
    const topics = await db.$queryRaw<{ event_type: string }[]>`SELECT event_type FROM outbox`
    expect(topics.map((t) => t.event_type)).toContain('fct.fulfillment.dispatch.v1')
    expect(await sixEventCount()).toBe(1)
  })

  // Spec 10c CC-1b: replaying the SAME client key is a dedup, not an error and
  // not a second effect. The audit trail must show ONE action, once.
  it('dedups a replay of the same client key, with no second trail row or 6e', async () => {
    const fx = await seedBatch(1)
    await send(fx, 'send-replay-key')

    const replay = await send(fx, 'send-replay-key')
    expect(replay.deduped).toBe(true)

    expect(await trailRows(fx.btchUuid)).toHaveLength(1)
    expect(await sixEventCount()).toBe(1)
  })

  it('refuses an empty batch with the batch-empty code, and writes nothing', async () => {
    const fx = await seedBatch(0)
    const err = await send(fx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpsClientError)
    expect((err as OpsClientError).kind).toBe('conflict')
    expect((err as OpsClientError).reasons).toEqual([{ code: 'batch-empty' }])
    expect(await statusOf(fx.btchUuid)).toBe('BATCHED')
    // The refusal rolled back: no trail row, no 6e, so a refused send is not
    // audited as an allowed one.
    expect(await trailRows(fx.btchUuid)).toHaveLength(0)
    expect(await sixEventCount()).toBe(0)
  })

  it('refuses while QR generation has not finished, with its own code', async () => {
    const fx = await seedBatch(2, null)
    const err = await send(fx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpsClientError)
    expect((err as OpsClientError).reasons).toEqual([{ code: 'qr-generation-incomplete' }])
    expect(await statusOf(fx.btchUuid)).toBe('BATCHED')
  })

  it('refuses a batch already sent, with the batch-already-sent code', async () => {
    const fx = await seedBatch(2, 'SENT_TO_VENDOR')
    const err = await send(fx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpsClientError)
    expect((err as OpsClientError).reasons).toEqual([{ code: 'batch-already-sent' }])
  })

  it('surfaces a missing or ambiguous print vendor as its own answerable code', async () => {
    await db.$executeRawUnsafe('TRUNCATE vndr CASCADE')
    const fx = await seedBatch(1)
    const err = await send(fx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpsClientError)
    expect((err as OpsClientError).reasons).toEqual([{ code: 'print-vendor-not-unique' }])
    expect(await statusOf(fx.btchUuid)).toBe('BATCHED')
  })

  it('is not-found for a batch that does not exist', async () => {
    const err = await sendBatchToVendor(db, {
      btchId: newId('btch'),
      clientKey: 'send-nosuch',
      actorId: ACTOR,
      traceId: 'trace-send',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OpsClientError)
    expect((err as OpsClientError).kind).toBe('not-found')
  })
})
