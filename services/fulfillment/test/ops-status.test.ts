import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { correctStatus, overrideTerminal } from '../src/ops.js'
import { type ShipmentFactPayload } from '../src/events.js'

const url = process.env.FULFILLMENT_DATABASE_URL
  ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const TENANT = toUuid(newId('tnnt'))

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, pending_pool_entry, outbox, inbox CASCADE',
  )
})
afterAll(async () => { await db.$disconnect() })

async function seedShipment(
  status: string,
  awb = `AWB-${randomUUID()}`,
): Promise<{ shptWire: string; shptUuid: string; programId: string; awb: string }> {
  const shptWire = newId('shpt')
  const shptUuid = toUuid(shptWire)
  const programUuid = toUuid(newId('prog'))
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptUuid}::uuid, ${awb}, NULL, ${status}, now(), ${TENANT}::uuid, ${programUuid}::uuid, now())
  `
  return { shptWire, shptUuid, programId: programUuid, awb }
}

async function shptRow(shptId: string) {
  const r = await db.$queryRaw<{ status: string; status_source: string | null }[]>`
    SELECT status, status_source FROM shpt WHERE id = ${shptId}::uuid
  `
  return r[0]!
}

async function latestEvent(shptId: string) {
  const r = await db.$queryRaw<{
    status: string; status_source: string; override_reason: string | null; source_ref: string
  }[]>`
    SELECT status, status_source, override_reason, source_ref FROM shpt_status_event
    WHERE shpt_id = ${shptId}::uuid ORDER BY received_at DESC, id DESC LIMIT 1
  `
  return r[0]
}

async function facts(): Promise<{ payload: Envelope<ShipmentFactPayload> }[]> {
  return db.$queryRaw`
    SELECT payload FROM outbox WHERE event_type = 'fct.fulfillment.shipment.v1' ORDER BY created_at ASC
  `
}

describe('ops status correction and privileged terminal override (spec 10c Task 6)', () => {
  it('a normal OPS_MANUAL correction advances via C3 and leaves override_reason NULL', async () => {
    const seeded = await seedShipment('IN_TRANSIT')
    const r = await correctStatus(db, {
      shptId: seeded.shptWire,
      status: 'OUT_FOR_DELIVERY',
      courierTimestamp: new Date('2026-07-27T10:00:00.000Z'),
      clientKey: randomUUID(),
      actorId: 'op-1',
      traceId: 't1',
    })
    expect(r.deduped).toBe(false)
    expect(r.outcome).toBe('advanced')

    const row = await shptRow(seeded.shptUuid)
    expect(row.status).toBe('OUT_FOR_DELIVERY')
    expect(row.status_source).toBe('OPS_MANUAL')

    const ev = await latestEvent(seeded.shptUuid)
    expect(ev).toBeDefined()
    expect(ev!.status).toBe('OUT_FOR_DELIVERY')
    expect(ev!.status_source).toBe('OPS_MANUAL')
    expect(ev!.override_reason).toBeNull()
    expect(ev!.source_ref).toBe('op-1')
  })

  it('a correction attempting to exit a terminal does NOT change shpt.status (non-advancing via C3)', async () => {
    const seeded = await seedShipment('DELIVERED')
    const r = await correctStatus(db, {
      shptId: seeded.shptWire,
      status: 'IN_TRANSIT',
      courierTimestamp: new Date('2026-07-27T11:00:00.000Z'),
      clientKey: randomUUID(),
      actorId: 'op-1',
      traceId: 't2',
    })
    expect(r.deduped).toBe(false)
    expect(r.outcome).toBe('trail_only')

    const row = await shptRow(seeded.shptUuid)
    expect(row.status).toBe('DELIVERED')

    // the trail append still happens (advanceShipmentStatus always appends),
    // but override_reason is never set on this path.
    const ev = await latestEvent(seeded.shptUuid)
    expect(ev!.status).toBe('IN_TRANSIT')
    expect(ev!.override_reason).toBeNull()
  })

  it('correctStatus replay (same clientKey) is deduped and does not double-apply', async () => {
    const seeded = await seedShipment('IN_TRANSIT')
    const clientKey = randomUUID()
    const args = {
      shptId: seeded.shptWire,
      status: 'OUT_FOR_DELIVERY',
      courierTimestamp: new Date('2026-07-27T12:00:00.000Z'),
      clientKey,
      actorId: 'op-1',
      traceId: 't3',
    }
    const first = await correctStatus(db, args)
    expect(first.deduped).toBe(false)
    expect(first.outcome).toBe('advanced')

    const replay = await correctStatus(db, { ...args, actorId: 'op-2' })
    expect(replay.deduped).toBe(true)
    expect(replay.outcome).toBeNull()

    const events = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt_status_event WHERE shpt_id = ${seeded.shptUuid}::uuid`
    expect(Number(events[0]!.n)).toBe(1)
    const f = await facts()
    expect(f).toHaveLength(1)
  })

  it('overrideTerminal rejects an empty or whitespace-only reason', async () => {
    const seeded = await seedShipment('DELIVERED')
    await expect(overrideTerminal(db, {
      shptId: seeded.shptWire, status: 'IN_TRANSIT', courierTimestamp: new Date(),
      overrideReason: '', clientKey: randomUUID(), actorId: 'op-1', traceId: 't4',
    })).rejects.toThrow()

    await expect(overrideTerminal(db, {
      shptId: seeded.shptWire, status: 'IN_TRANSIT', courierTimestamp: new Date(),
      overrideReason: '   ', clientKey: randomUUID(), actorId: 'op-1', traceId: 't4b',
    })).rejects.toThrow()

    // neither rejected attempt touched shpt.status.
    expect((await shptRow(seeded.shptUuid)).status).toBe('DELIVERED')
  })

  it('overrideTerminal with a real reason reopens a DELIVERED shpt, audits the reason on the domain row, and emits a fact WITHOUT the reason text', async () => {
    const seeded = await seedShipment('DELIVERED')
    const reason = 'customer reported wrong terminal, correcting per support ticket 4471'
    const ok = await overrideTerminal(db, {
      shptId: seeded.shptWire,
      status: 'IN_TRANSIT',
      courierTimestamp: new Date('2026-07-27T13:00:00.000Z'),
      overrideReason: reason,
      clientKey: randomUUID(),
      actorId: 'op-1',
      traceId: 't5',
    })
    expect(ok.deduped).toBe(false)
    expect(ok.overridden).toBe(true)

    const row = await shptRow(seeded.shptUuid)
    expect(row.status).toBe('IN_TRANSIT')
    expect(row.status_source).toBe('OPS_MANUAL')

    const ev = await latestEvent(seeded.shptUuid)
    expect(ev!.status).toBe('IN_TRANSIT')
    expect(ev!.status_source).toBe('OPS_MANUAL')
    expect(ev!.override_reason).toBe(reason)

    const f = await facts()
    expect(f).toHaveLength(1)
    const factJson = JSON.stringify(f[0]!.payload)
    expect(factJson).not.toContain(reason)
    expect(factJson).not.toContain('support ticket')
    expect(f[0]!.payload.payload.shptId).toBe(seeded.shptWire)
    expect(f[0]!.payload.payload.status).toBe('IN_TRANSIT')
    expect(f[0]!.payload.payload.statusSource).toBe('OPS_MANUAL')
  })

  it('overrideTerminal replay (same clientKey) is deduped and does not double-apply', async () => {
    const seeded = await seedShipment('DELIVERED')
    const clientKey = randomUUID()
    const args = {
      shptId: seeded.shptWire,
      status: 'IN_TRANSIT',
      courierTimestamp: new Date('2026-07-27T14:00:00.000Z'),
      overrideReason: 'reopen: wrong terminal reported',
      clientKey,
      actorId: 'op-1',
      traceId: 't6',
    }
    const first = await overrideTerminal(db, args)
    expect(first.deduped).toBe(false)
    expect(first.overridden).toBe(true)

    const replay = await overrideTerminal(db, { ...args, actorId: 'op-2' })
    expect(replay.deduped).toBe(true)
    expect(replay.overridden).toBe(true)

    const events = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt_status_event WHERE shpt_id = ${seeded.shptUuid}::uuid`
    expect(Number(events[0]!.n)).toBe(1)
    const f = await facts()
    expect(f).toHaveLength(1)
  })

  // The override is the SECOND transition emitter, and the D-24 close must
  // fire from it too: an operator hand-marking a collateral parcel DELIVERED
  // is exactly the expedite path a phone complaint takes (REVIEW_REPORT.md F1).
  it('an overridden DELIVERED on a collateral parcel carries collateral + asgnIds on its fact', async () => {
    const seeded = await seedShipment('IN_TRANSIT')
    const asgnUuid = toUuid(newId('asgn'))
    await db.$executeRaw`
      INSERT INTO pending_pool_entry (
        asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
        merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
        ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id,
        dispatch_group, collateral_shipment, created_at, updated_at
      ) VALUES (
        ${asgnUuid}::uuid, ${TENANT}::uuid, ${seeded.programId}::uuid, false, 1, 0, false,
        'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
        'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${`f1o-${asgnUuid}`}, 'trace-f1o',
        'COLLATERAL', ${seeded.shptUuid}::uuid, now(), now()
      )
    `
    const ok = await overrideTerminal(db, {
      shptId: seeded.shptWire,
      status: 'DELIVERED',
      courierTimestamp: new Date('2026-08-16T12:00:00.000Z'),
      overrideReason: 'courier portal shows delivered, feed missed it',
      clientKey: randomUUID(),
      actorId: 'op-1',
      traceId: 't-f1o',
    })
    expect(ok.overridden).toBe(true)

    const f = await facts()
    expect(f).toHaveLength(1)
    const payload = f[0]!.payload.payload
    expect(payload.status).toBe('DELIVERED')
    expect(payload.collateral).toBe(true)
    expect(payload.asgnIds).toEqual([fromUuid('asgn', asgnUuid)])
  })
})
