import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { advanceShipmentStatus, LADDER_RANK, isKnownStatus } from '../src/courier-status.js'
import { type ShipmentFactPayload } from '../src/events.js'
import { type Tx } from '../src/internal.js'

const url = process.env.FULFILLMENT_DATABASE_URL
  ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasources: { db: { url } } })

const PROGRAM = toUuid(newId('prog'))
const TENANT = toUuid(newId('tnnt'))
const AWB = 'AWB-COURIER-1'

async function seedShipment(awb = AWB): Promise<string> {
  const shptUuid = toUuid(newId('shpt'))
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptUuid}::uuid, ${awb}, NULL, 'DISPATCHED_BY_VENDOR', now(), ${TENANT}::uuid, ${PROGRAM}::uuid, now())
  `
  return shptUuid
}

function at(iso: string): Date { return new Date(iso) }

async function advance(status: string, iso: string, awb = AWB) {
  return db.$transaction(async (tx: Tx) =>
    advanceShipmentStatus(tx, {
      awb, status, courierTimestamp: at(iso), source: 'BATCH_FILE',
      sourceRef: `vndr_c1|file-1`, traceId: 'trace-courier-1',
    }),
  )
}

async function shptRow(awb = AWB) {
  const r = await db.$queryRaw<{ status: string; status_at: Date | null; status_source: string | null }[]>`
    SELECT status, status_at, status_source FROM shpt WHERE awb = ${awb}
  `
  return r[0]!
}

async function trail(shptUuid: string) {
  return db.$queryRaw<{ status: string; courier_timestamp: Date; trace_id: string; status_source: string }[]>`
    SELECT status, courier_timestamp, trace_id, status_source FROM shpt_status_event
    WHERE shpt_id = ${shptUuid}::uuid ORDER BY courier_timestamp ASC
  `
}

// The outbox has NO dedup_key column (that is on the inbox). The dedupKey is a
// top-level field of the E4 envelope, which is stored whole in outbox.payload.
// So read `payload` and access payload.dedupKey and payload.payload.<factField>,
// exactly as dispatch.test.ts and return-sheet.test.ts do.
async function facts(): Promise<{ payload: Envelope<ShipmentFactPayload> }[]> {
  return db.$queryRaw`
    SELECT payload FROM outbox WHERE event_type = 'fct.fulfillment.shipment.v1' ORDER BY created_at ASC
  `
}

describe('courier carrier-status advance', () => {
  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE shpt_status_event, courier_status_exception, shpt, outbox, inbox CASCADE`
  })
  // Truncating ONLY in beforeEach leaves whatever the FINAL test inserted
  // sitting in the database for the rest of the gate and beyond (F-9, F-9b).
  // A test fixture is not demo data and must not outlive the test. Note this
  // list is this suite's OWN and deliberately omits vndr, which it never
  // writes: a shared teardown list would truncate tables a suite does not own.
  afterAll(async () => {
    await db.$executeRaw`TRUNCATE shpt_status_event, courier_status_exception, shpt, outbox, inbox CASCADE`
    await db.$disconnect()
  })

  it('advances the full ladder, appends one trail row per update, and emits one fact per transition (check 1)', async () => {
    const shptUuid = await seedShipment()
    expect(await advance('PICKED_UP', '2026-07-25T10:00:00.000Z')).toBe('advanced')
    expect(await advance('IN_TRANSIT', '2026-07-25T11:00:00.000Z')).toBe('advanced')
    expect(await advance('OUT_FOR_DELIVERY', '2026-07-25T12:00:00.000Z')).toBe('advanced')
    expect(await advance('DELIVERED', '2026-07-25T13:00:00.000Z')).toBe('advanced')

    const row = await shptRow()
    expect(row.status).toBe('DELIVERED')
    expect(row.status_at!.toISOString()).toBe('2026-07-25T13:00:00.000Z')
    expect(row.status_source).toBe('BATCH_FILE')

    const t = await trail(shptUuid)
    expect(t.map((x) => x.status)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'])
    expect(t.every((x) => x.trace_id === 'trace-courier-1')).toBe(true)

    const f = await facts()
    expect(f).toHaveLength(4)
    expect(f.map((x) => x.payload.payload.status)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'])
  })

  it('uses a per-transition composite dedupKey, never the bare shpt id', async () => {
    const shptUuid = await seedShipment()
    await advance('PICKED_UP', '2026-07-25T10:00:00.000Z')
    const shptWire = fromUuid('shpt', shptUuid)
    const f = await facts()
    expect(f[0]!.payload.dedupKey).toBe(`${shptWire}|PICKED_UP|2026-07-25T10:00:00.000Z`)
    expect(f[0]!.payload.dedupKey).not.toBe(shptWire)
  })

  it('re-reporting the same status is a no-op: no second trail row, no second fact (check 2)', async () => {
    const shptUuid = await seedShipment()
    expect(await advance('IN_TRANSIT', '2026-07-25T11:00:00.000Z')).toBe('advanced')
    expect(await advance('IN_TRANSIT', '2026-07-25T11:00:00.000Z')).toBe('deduped')
    expect(await trail(shptUuid)).toHaveLength(1)
    expect(await facts()).toHaveLength(1)
    expect((await shptRow()).status).toBe('IN_TRANSIT')
  })

  it('a backward ladder move with a NEWER timestamp is trailed but does NOT regress (check 2)', async () => {
    const shptUuid = await seedShipment()
    await advance('IN_TRANSIT', '2026-07-25T11:00:00.000Z')
    // PICKED_UP (rank 1) arriving AFTER IN_TRANSIT (rank 2), newer timestamp: a
    // backward ladder move. Trailed, but status stays IN_TRANSIT.
    expect(await advance('PICKED_UP', '2026-07-25T12:00:00.000Z')).toBe('trail_only')

    const row = await shptRow()
    expect(row.status).toBe('IN_TRANSIT')
    expect(row.status_at!.toISOString()).toBe('2026-07-25T11:00:00.000Z')
    expect((await trail(shptUuid)).map((x) => x.status)).toEqual(['IN_TRANSIT', 'PICKED_UP'])
    expect(await facts()).toHaveLength(1)
  })

  it('an older-timestamp status is trailed but does NOT regress (check 2)', async () => {
    const shptUuid = await seedShipment()
    await advance('OUT_FOR_DELIVERY', '2026-07-25T13:00:00.000Z')
    expect(await advance('IN_TRANSIT', '2026-07-25T11:00:00.000Z')).toBe('trail_only')
    expect((await shptRow()).status).toBe('OUT_FOR_DELIVERY')
    expect((await trail(shptUuid)).map((x) => x.status)).toEqual(['IN_TRANSIT', 'OUT_FOR_DELIVERY'])
  })

  it('FAILED and RETURNED are distinct reachable tokens from an in-flight state (check 2)', async () => {
    await seedShipment('AWB-F')
    await seedShipment('AWB-R')
    await advance('IN_TRANSIT', '2026-07-25T10:00:00.000Z', 'AWB-F')
    await advance('IN_TRANSIT', '2026-07-25T10:00:00.000Z', 'AWB-R')

    expect(await advance('FAILED', '2026-07-25T14:00:00.000Z', 'AWB-F')).toBe('advanced')
    expect(await advance('RETURNED', '2026-07-25T14:00:00.000Z', 'AWB-R')).toBe('advanced')

    expect((await shptRow('AWB-F')).status).toBe('FAILED')
    expect((await shptRow('AWB-R')).status).toBe('RETURNED')
    expect(LADDER_RANK['FAILED']).toBeUndefined()
    expect(LADDER_RANK['RETURNED']).toBeUndefined()
    expect(isKnownStatus('FAILED') && isKnownStatus('RETURNED')).toBe(true)
  })

  it('FAILED is NON-terminal: it re-attempts forward and can be DELIVERED (D9)', async () => {
    await seedShipment()
    await advance('IN_TRANSIT', '2026-07-25T10:00:00.000Z')
    expect(await advance('FAILED', '2026-07-25T12:00:00.000Z')).toBe('advanced')
    // re-attempt onto the ladder from FAILED
    expect(await advance('OUT_FOR_DELIVERY', '2026-07-25T14:00:00.000Z')).toBe('advanced')
    expect(await advance('DELIVERED', '2026-07-25T16:00:00.000Z')).toBe('advanced')
    expect((await shptRow()).status).toBe('DELIVERED')
  })

  it('RETURNED is reachable from FAILED, preserving the D116 RTO trigger (D9)', async () => {
    await seedShipment()
    await advance('OUT_FOR_DELIVERY', '2026-07-25T10:00:00.000Z')
    expect(await advance('FAILED', '2026-07-25T12:00:00.000Z')).toBe('advanced')
    expect(await advance('RETURNED', '2026-07-25T14:00:00.000Z')).toBe('advanced')
    expect((await shptRow()).status).toBe('RETURNED')
  })

  it('terminal is exactly {DELIVERED, RETURNED}: nothing advances past them', async () => {
    await seedShipment('AWB-D')
    await seedShipment('AWB-RT')
    await advance('DELIVERED', '2026-07-25T13:00:00.000Z', 'AWB-D')
    await advance('RETURNED', '2026-07-25T13:00:00.000Z', 'AWB-RT')
    // even a strictly-newer event does not move a terminal shipment
    expect(await advance('FAILED', '2026-07-25T15:00:00.000Z', 'AWB-D')).toBe('trail_only')
    expect(await advance('IN_TRANSIT', '2026-07-25T15:00:00.000Z', 'AWB-RT')).toBe('trail_only')
    expect((await shptRow('AWB-D')).status).toBe('DELIVERED')
    expect((await shptRow('AWB-RT')).status).toBe('RETURNED')
  })

  it('an unknown AWB resolves to unknown_awb and writes nothing (103d)', async () => {
    expect(await advance('PICKED_UP', '2026-07-25T10:00:00.000Z', 'AWB-DOES-NOT-EXIST')).toBe('unknown_awb')
    const t = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM shpt_status_event`
    expect(Number(t[0]!.c)).toBe(0)
    expect(await facts()).toHaveLength(0)
  })
})
