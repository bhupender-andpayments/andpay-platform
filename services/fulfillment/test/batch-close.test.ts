import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { closeBatch, OpsClientError } from '../src/ops.js'
import { readBatchDetail } from '../src/ops-read.js'

// CLOSING A BATCH (decision D5, 18 Aug 2026).
//
// Closing is the operator saying "this run is finished and I am done looking at
// it". That is a judgement, so it is manual; but CLOSED has to mean something,
// so it is gated on every dispatch having SETTLED, meaning it stopped travelling
// one way or another: DELIVERED, RETURNED, or its device DAMAGED.
//
// The gate is re-checked inside the write transaction rather than trusted from
// the read the portal used to enable its button, because a courier webhook or a
// damage flag can land between the two, and because a client is never the
// authority on whether a write is legal.

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const ACTOR = 'c0000000-0000-4000-8000-00000000000a'
const MANUFACTURER = 'e2000000-0000-4000-8000-00000000000b'

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, unit, shpt, batch, batch_pool, saga_step, saga_instance, outbox, inbox CASCADE',
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

/**
 * A batch already sent to the print vendor, with `count` dispatches on it.
 *
 * Seeded at SENT_TO_PRINT_VENDOR because that is the only state closing is
 * offered from: a batch nobody has sent has nothing to settle.
 */
async function seedSentBatch(count: number): Promise<Fixture> {
  const btchWire = newId('btch')
  const btchUuid = toUuid(btchWire)
  const tenantUuid = toUuid(newId('tnnt'))
  const programUuid = toUuid(newId('prog'))
  await db.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, 'SENT_TO_PRINT_VENDOR', 'LOT_SIZE', ${count}, now())
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
        'BATCHED', ${btchUuid}::uuid, 'DISPATCHED_BY_VENDOR', ${`seed|${String(i)}`}, 'trace-close', now()
      )
    `
  }
  return { btchWire, btchUuid, programUuid, asgnWires }
}

/** A device on this dispatch, in a shipment at `shipmentStatus`. */
async function seedShippedDevice(
  fx: Fixture,
  asgnWire: string,
  shipmentStatus: string,
  unitStatus = 'DISPATCHED',
): Promise<void> {
  const shptUuid = toUuid(newId('shpt'))
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptUuid}::uuid, ${newId('shpt')}, ${shipmentStatus}, now(),
            (SELECT tenant_id FROM batch WHERE id = ${fx.btchUuid}::uuid),
            ${fx.programUuid}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, shipment, updated_at)
    VALUES (gen_random_uuid(), 'SERIALIZED', 'SOUNDBOX', ${MANUFACTURER}::uuid, ${unitStatus},
            ${`SER-${crypto.randomUUID()}`}, ${toUuid(asgnWire)}::uuid, ${shptUuid}::uuid, now())
  `
}

async function statusOf(btchUuid: string): Promise<string> {
  const rows = await db.$queryRaw<{ status: string }[]>`
    SELECT status FROM batch WHERE id = ${btchUuid}::uuid
  `
  return rows[0]!.status
}

async function sixEventCount(): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox WHERE payload->>'decision' = 'ALLOW'
  `
  return Number(rows[0]!.n)
}

describe('closeBatch: manual, and gated on every dispatch having settled', () => {
  it('closes a batch whose dispatches all reached a terminal courier state', async () => {
    const fx = await seedSentBatch(2)
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'DELIVERED', 'DELIVERED')
    await seedShippedDevice(fx, fx.asgnWires[1]!, 'RETURNED')

    const res = await closeBatch(db, {
      btchId: fx.btchWire,
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      traceId: 'trace-close-1',
    })
    expect(res.closed).toBe(true)
    expect(res.deduped).toBe(false)
    // The breakdown travels with the verdict: "you cannot close this" is not an
    // answer an operator can act on, and neither is "done" with no account of what.
    expect(res.settlement).toMatchObject({ total: 2, delivered: 1, returned: 1, pending: 0, settled: true })
    expect(await statusOf(fx.btchUuid)).toBe('CLOSED')
  })

  // REVERSED 19 Aug 2026, at the product owner's direction. This used to assert
  // that a DAMAGED device settles its dispatch, on the reasoning that a
  // replacement has been raised so the outcome is known. Two things were wrong
  // with it.
  //
  // It read the wrong axis. `unit.status` is the DEVICE's; the whole breakdown is
  // about DISPATCHES, and the batch page's State column renders
  // pending_pool_entry.dispatch_state, which has no damaged value. So the close
  // dialog reported "1 damaged" over a table of identical Dispatched by vendor
  // rows, and the operator could not find the row the number referred to.
  //
  // And damage is not a travel outcome. The parcel is still with the courier and
  // will deliver or come back RTO; that event settles the row. A parcel that
  // genuinely stops moving without one is what the shipment override is for.
  it('does NOT settle a dispatch just because its device was flagged damaged', async () => {
    const fx = await seedSentBatch(1)
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'IN_TRANSIT', 'DAMAGED')
    await expect(
      closeBatch(db, {
        btchId: fx.btchWire,
        clientKey: crypto.randomUUID(),
        actorId: ACTOR,
        traceId: 'trace-close-2',
      }),
    ).rejects.toThrow(/still in flight/i)
    expect(await statusOf(fx.btchUuid)).toBe('SENT_TO_PRINT_VENDOR')
  })

  it('settles that same dispatch once its parcel reaches a courier terminal state', async () => {
    const fx = await seedSentBatch(1)
    // Damaged device, and the parcel came back: RETURNED is the travel outcome,
    // and it is what the count reports.
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'RETURNED', 'DAMAGED')
    const res = await closeBatch(db, {
      btchId: fx.btchWire,
      clientKey: crypto.randomUUID(),
      actorId: ACTOR,
      traceId: 'trace-close-2b',
    })
    expect(res.settlement).toMatchObject({ total: 1, returned: 1, pending: 0, settled: true })
    expect(await statusOf(fx.btchUuid)).toBe('CLOSED')
  })

  it('REFUSES while a dispatch is still in flight, and says how many', async () => {
    const fx = await seedSentBatch(3)
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'DELIVERED', 'DELIVERED')
    await seedShippedDevice(fx, fx.asgnWires[1]!, 'IN_TRANSIT')
    // The third has no shipment at all: the vendor has not returned that row, so
    // it cannot have settled however long ago the batch formed.

    await expect(
      closeBatch(db, { btchId: fx.btchWire, clientKey: crypto.randomUUID(), actorId: ACTOR, traceId: 't' }),
    ).rejects.toThrow(OpsClientError)
    await expect(
      closeBatch(db, { btchId: fx.btchWire, clientKey: crypto.randomUUID(), actorId: ACTOR, traceId: 't' }),
    ).rejects.toThrow(/2 of 3/)
    // Rolled back entirely: not closed, and no ALLOW recorded for an action that
    // did not happen.
    expect(await statusOf(fx.btchUuid)).toBe('SENT_TO_PRINT_VENDOR')
    expect(await sixEventCount()).toBe(0)
  })

  it('is idempotent on a replayed client key, and does not close twice', async () => {
    const fx = await seedSentBatch(1)
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'DELIVERED', 'DELIVERED')
    const clientKey = crypto.randomUUID()
    const first = await closeBatch(db, { btchId: fx.btchWire, clientKey, actorId: ACTOR, traceId: 't' })
    expect(first.closed).toBe(true)
    const replay = await closeBatch(db, { btchId: fx.btchWire, clientKey, actorId: ACTOR, traceId: 't' })
    // A retry of a completed action is not an error: same key, no second effect.
    expect(replay.deduped).toBe(true)
    expect(replay.closed).toBe(false)
    expect(await sixEventCount()).toBe(1)
  })

  it('refuses a FRESH attempt at a batch that is already closed', async () => {
    const fx = await seedSentBatch(1)
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'DELIVERED', 'DELIVERED')
    await closeBatch(db, { btchId: fx.btchWire, clientKey: crypto.randomUUID(), actorId: ACTOR, traceId: 't' })
    await expect(
      closeBatch(db, { btchId: fx.btchWire, clientKey: crypto.randomUUID(), actorId: ACTOR, traceId: 't' }),
    ).rejects.toThrow(/already closed/)
  })

  it('reports a missing batch as not-found, never as a settlement problem', async () => {
    await expect(
      closeBatch(db, { btchId: newId('btch'), clientKey: crypto.randomUUID(), actorId: ACTOR, traceId: 't' }),
    ).rejects.toThrow(/batch not found/)
  })
})

describe('readBatchDetail settlement: the same numbers the close gate uses', () => {
  it('reports the breakdown the portal shows beside its disabled Close button', async () => {
    const fx = await seedSentBatch(3)
    await seedShippedDevice(fx, fx.asgnWires[0]!, 'DELIVERED', 'DELIVERED')
    await seedShippedDevice(fx, fx.asgnWires[1]!, 'RETURNED')
    await seedShippedDevice(fx, fx.asgnWires[2]!, 'OUT_FOR_DELIVERY')

    const detail = await readBatchDetail(db, fx.btchWire)
    expect(detail).not.toBeNull()
    expect(detail!.settlement).toMatchObject({
      total: 3,
      delivered: 1,
      returned: 1,
      pending: 1,
      settled: false,
    })
  })

  it('treats a batch nobody has shipped as entirely pending, not as settled-by-default', async () => {
    // The empty-shipment case is the one an off-by-one would get wrong in the
    // dangerous direction: closing a batch that never went anywhere.
    const fx = await seedSentBatch(2)
    const detail = await readBatchDetail(db, fx.btchWire)
    expect(detail!.settlement).toMatchObject({ total: 2, pending: 2, settled: false })
  })
})
