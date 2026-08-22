import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import {
  holdRecord,
  releaseRecord,
  correctUnitStatus,
  correctDispatchState,
  bulkDeliverBatch,
  OpsClientError,
} from '../src/ops.js'
import { readPoolEntryTrailOps, readUnitTrailOps } from '../src/ops-read.js'

// THE STATUS TRAILS THEMSELVES (22 Aug 2026). The three tables landed on 20
// Aug and were exercised only INDIRECTLY, through the flows that write them;
// nothing asserted a single trail row until this file. What it pins:
//
//  - every ops door writes its row in the SAME transaction, with the door's
//    own source token,
//  - actor_display carries the operator's login handle (the LeanClaim.hdl
//    snapshot) on human doors and stays NULL on machine doors,
//  - the manual dispatch_state correction is forward-only and refuses a row
//    batching has not QR'd,
//  - the bulk deliver skips a dispatch whose device is DAMAGED (22 Aug ruling:
//    damaged is settled, and settled rows are not overwritten).

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const ACTOR = 'c0000000-0000-4000-8000-00000000000a'
const HANDLE = 'ops.admin'
const MANUFACTURER = 'e2000000-0000-4000-8000-00000000000b'

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, pool_entry_status_event, unit, unit_status_event, shpt, shpt_status_event, batch, batch_status_event, batch_pool, saga_step, saga_instance, outbox, inbox CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

interface SeededEntry {
  asgnWire: string
  btchUuid: string
  programUuid: string
  tenantUuid: string
}

async function seedEntry(opts: { poolStatus: string; dispatchState: string | null }): Promise<SeededEntry> {
  const btchUuid = toUuid(newId('btch'))
  const tenantUuid = toUuid(newId('tnnt'))
  const programUuid = toUuid(newId('prog'))
  const asgnWire = newId('asgn')
  const inBatch = opts.poolStatus === 'BATCHED'
  if (inBatch) {
    await db.$executeRaw`
      INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
      VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'SENT_TO_PRINT_VENDOR', 'LOT_SIZE', 1, now())
    `
  }
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
    ) VALUES (
      ${toUuid(asgnWire)}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid,
      true, 0, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank',
      '221B Baker Street', 'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank',
      ${opts.poolStatus}, ${inBatch ? btchUuid : null}::uuid, ${opts.dispatchState},
      ${`seed|${asgnWire}`}, 'trace-trails', now()
    )
  `
  return { asgnWire, btchUuid, programUuid, tenantUuid }
}

async function poolTrail(asgnWire: string): Promise<{ status: string; source: string; display: string | null }[]> {
  return (
    await db.$queryRaw<{ status: string; status_source: string; actor_display: string | null }[]>`
      SELECT e.status, e.status_source, e.actor_display
      FROM pool_entry_status_event e
      JOIN pending_pool_entry p ON p.id = e.pool_entry_id
      WHERE p.asgn_id = ${toUuid(asgnWire)}::uuid
      ORDER BY e.created_at ASC
    `
  ).map((r) => ({ status: r.status, source: r.status_source, display: r.actor_display }))
}

describe('hold and release write the pool trail with the operator handle', () => {
  it('HELD then POOLED, each carrying source, actor and the hdl snapshot', async () => {
    const fx = await seedEntry({ poolStatus: 'POOLED', dispatchState: null })
    await holdRecord(db, {
      asgnId: fx.asgnWire,
      reason: 'bank asked us to wait',
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't-hold',
    })
    await releaseRecord(db, {
      asgnId: fx.asgnWire,
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't-release',
    })
    expect(await poolTrail(fx.asgnWire)).toEqual([
      { status: 'HELD', source: 'batching:hold', display: HANDLE },
      { status: 'POOLED', source: 'ops:release-hold', display: HANDLE },
    ])
  })

  it('the ops read surfaces actorDisplay, so the rail can say who', async () => {
    const fx = await seedEntry({ poolStatus: 'POOLED', dispatchState: null })
    await holdRecord(db, {
      asgnId: fx.asgnWire,
      reason: 'r',
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't',
    })
    const trail = await readPoolEntryTrailOps(db, fx.asgnWire)
    expect(trail).toHaveLength(1)
    expect(trail[0]!.actorDisplay).toBe(HANDLE)
  })
})

describe('correctUnitStatus stamps the handle on the device trail', () => {
  it('writes the trail row with ops source and the hdl snapshot', async () => {
    const unitUuid = crypto.randomUUID()
    await db.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, updated_at)
      VALUES (${unitUuid}::uuid, 'SERIALIZED', 'SOUNDBOX', ${MANUFACTURER}::uuid, 'IN_STOCK', 'SER-TRAIL-1', now())
    `
    const res = await correctUnitStatus(db, {
      unitId: fromUuid('unit', unitUuid),
      status: 'PRINTED',
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't-unit',
    })
    expect(res.advanced).toBe(true)
    const trail = await readUnitTrailOps(db, fromUuid('unit', unitUuid))
    expect(trail).toHaveLength(1)
    expect(trail[0]).toMatchObject({
      status: 'PRINTED',
      statusSource: 'ops:correct-unit-status',
      actorDisplay: HANDLE,
    })
  })
})

describe('correctDispatchState: the manual dispatch-axis correction', () => {
  it('moves SENT_TO_VENDOR forward to DISPATCHED_BY_VENDOR, logs it, and emits the dispatch fact', async () => {
    const fx = await seedEntry({ poolStatus: 'BATCHED', dispatchState: 'SENT_TO_VENDOR' })
    const res = await correctDispatchState(db, {
      asgnId: fx.asgnWire,
      state: 'DISPATCHED_BY_VENDOR',
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't-state',
    })
    expect(res).toEqual({ deduped: false, advanced: true })
    const rows = await db.$queryRaw<{ dispatch_state: string }[]>`
      SELECT dispatch_state FROM pending_pool_entry WHERE asgn_id = ${toUuid(fx.asgnWire)}::uuid
    `
    expect(rows[0]!.dispatch_state).toBe('DISPATCHED_BY_VENDOR')
    expect(await poolTrail(fx.asgnWire)).toEqual([
      { status: 'DISPATCHED_BY_VENDOR', source: 'ops:correct-dispatch-state', display: HANDLE },
    ])
    // The fact rides the SAME topic the automatic step publishes, with this
    // one asgn, so the case In-Progress automation follows a manual
    // correction exactly as it follows the real handover.
    const facts = await db.$queryRaw<{ payload: { payload: { asgnIds: string[]; dispatchState: string } } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'fct.fulfillment.dispatch.v1'
    `
    expect(facts).toHaveLength(1)
    expect(facts[0]!.payload.payload).toMatchObject({
      asgnIds: [fx.asgnWire],
      dispatchState: 'DISPATCHED_BY_VENDOR',
    })
  })

  it('is forward-only: refuses to move DISPATCHED_BY_VENDOR back, and logs nothing', async () => {
    const fx = await seedEntry({ poolStatus: 'BATCHED', dispatchState: 'DISPATCHED_BY_VENDOR' })
    const res = await correctDispatchState(db, {
      asgnId: fx.asgnWire,
      state: 'SENT_TO_VENDOR',
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't-back',
    })
    // advanced false, not a throw: the guard lives in the WHERE clause, and a
    // no-move is a truthful answer under concurrency.
    expect(res).toEqual({ deduped: false, advanced: false })
    expect(await poolTrail(fx.asgnWire)).toEqual([])
  })

  it('refuses a row batching has not QR generated (dispatch_state NULL)', async () => {
    const fx = await seedEntry({ poolStatus: 'POOLED', dispatchState: null })
    await expect(
      correctDispatchState(db, {
        asgnId: fx.asgnWire,
        state: 'DISPATCHED_BY_VENDOR',
        clientKey: crypto.randomUUID(),
        actorId: ACTOR,
        traceId: 't-null',
      }),
    ).rejects.toThrow(OpsClientError)
  })

  it('refuses QR_GENERATED as a target: batching itself is its only writer', async () => {
    const fx = await seedEntry({ poolStatus: 'BATCHED', dispatchState: 'SENT_TO_VENDOR' })
    await expect(
      correctDispatchState(db, {
        asgnId: fx.asgnWire,
        state: 'QR_GENERATED',
        clientKey: crypto.randomUUID(),
        actorId: ACTOR,
        traceId: 't-qr',
      }),
    ).rejects.toThrow(/QR_GENERATED/)
  })

  it('a replayed clientKey is deduped and appends no second trail row', async () => {
    const fx = await seedEntry({ poolStatus: 'BATCHED', dispatchState: 'SENT_TO_VENDOR' })
    const clientKey = crypto.randomUUID()
    const first = await correctDispatchState(db, {
      asgnId: fx.asgnWire,
      state: 'DISPATCHED_BY_VENDOR',
      clientKey,
      actorId: ACTOR,
      traceId: 't-replay',
    })
    expect(first.advanced).toBe(true)
    const replay = await correctDispatchState(db, {
      asgnId: fx.asgnWire,
      state: 'DISPATCHED_BY_VENDOR',
      clientKey,
      actorId: ACTOR,
      traceId: 't-replay',
    })
    expect(replay).toEqual({ deduped: true, advanced: false })
    expect(await poolTrail(fx.asgnWire)).toHaveLength(1)
  })
})

describe('bulkDeliverBatch leaves damaged dispatches alone (22 Aug 2026 ruling)', () => {
  it('delivers the in-flight shipment and does not touch the damaged one', async () => {
    // One batch, two dispatches, each with its own shipment IN_TRANSIT; one
    // device is DAMAGED. The bulk shortcut must deliver exactly one.
    const btchUuid = toUuid(newId('btch'))
    const tenantUuid = toUuid(newId('tnnt'))
    const programUuid = toUuid(newId('prog'))
    await db.$executeRaw`
      INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
      VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'SENT_TO_PRINT_VENDOR', 'LOT_SIZE', 2, now())
    `
    const seedOne = async (unitStatus: string): Promise<string> => {
      const asgnWire = newId('asgn')
      const shptUuid = toUuid(newId('shpt'))
      await db.$executeRaw`
        INSERT INTO pending_pool_entry (
          asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
          merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
          ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
        ) VALUES (
          ${toUuid(asgnWire)}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${toUuid(newId('mrch'))}::uuid,
          true, 0, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank',
          '221B', 'upi://x', 'x@bank', 'BATCHED', ${btchUuid}::uuid, 'DISPATCHED_BY_VENDOR',
          ${`seed|${asgnWire}`}, 'trace-bulk', now()
        )
      `
      await db.$executeRaw`
        INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
        VALUES (${shptUuid}::uuid, ${newId('shpt')}, 'IN_TRANSIT', now(), ${tenantUuid}::uuid, ${programUuid}::uuid, now())
      `
      await db.$executeRaw`
        INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, shipment, updated_at)
        VALUES (gen_random_uuid(), 'SERIALIZED', 'SOUNDBOX', ${MANUFACTURER}::uuid, ${unitStatus},
                ${`SER-${crypto.randomUUID()}`}, ${toUuid(asgnWire)}::uuid, ${shptUuid}::uuid, now())
      `
      return asgnWire
    }
    const healthy = await seedOne('DISPATCHED')
    const damaged = await seedOne('DAMAGED')

    const res = await bulkDeliverBatch(db, {
      batchId: fromUuid('btch', btchUuid),
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      actorDisplay: HANDLE,
      traceId: 't-bulk',
    })
    expect(res.delivered).toBe(1)
    expect(res.failed).toBe(0)

    const statusFor = async (asgnWire: string): Promise<string> => {
      const rows = await db.$queryRaw<{ status: string }[]>`
        SELECT s.status FROM shpt s JOIN unit u ON u.shipment = s.id
        WHERE u.asgn_id = ${toUuid(asgnWire)}::uuid
      `
      return rows[0]!.status
    }
    expect(await statusFor(healthy)).toBe('DELIVERED')
    // The damaged dispatch's parcel is untouched: damaged is settled, and the
    // shortcut must not overwrite a settled row as delivered.
    expect(await statusFor(damaged)).toBe('IN_TRANSIT')
  })
})
