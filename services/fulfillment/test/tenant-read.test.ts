import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readShipments, readShipmentStatusTrail } from '../src/read.js'

const url = process.env.FULFILLMENT_DATABASE_URL
  ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, outbox, inbox CASCADE',
  )
})
afterAll(async () => { await db.$disconnect() })

interface Seeded {
  shptA: string
  shptB: string
  progA: string
  progB: string
}

// Seeds one shpt row per Program (A and B), all NOT NULL columns populated,
// updated_at=now(); plus a carrier-status trail for A (two events, inserted
// out of chronological order to prove ORDER BY courier_timestamp ASC) and one
// event for B. shpt_status_event has no updated_at (append-only, S13/107a).
async function seed(): Promise<Seeded> {
  const shptA = toUuid(newId('shpt'))
  const shptB = toUuid(newId('shpt'))
  const progA = toUuid(newId('prog'))
  const progB = toUuid(newId('prog'))
  const tnntA = toUuid(newId('tnnt'))
  const tnntB = toUuid(newId('tnnt'))

  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptA}::uuid, 'AWB-A-1', NULL, 'IN_TRANSIT', now(), ${tnntA}::uuid, ${progA}::uuid, now())
  `
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptB}::uuid, 'AWB-B-1', NULL, 'DISPATCHED_BY_VENDOR', now(), ${tnntB}::uuid, ${progB}::uuid, now())
  `

  // A's trail: inserted latest-first so a naive insertion-order read would fail
  // the ascending-order assertion.
  await db.$executeRaw`
    INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
    VALUES (${shptA}::uuid, ${progA}::uuid, 'OUT_FOR_DELIVERY', '2026-07-20T09:00:00Z'::timestamptz, 'WEBHOOK', 'ref-a-2', 'trace-a')
  `
  await db.$executeRaw`
    INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
    VALUES (${shptA}::uuid, ${progA}::uuid, 'PICKED_UP', '2026-07-20T08:00:00Z'::timestamptz, 'BATCH_FILE', 'ref-a-1', 'trace-a')
  `
  await db.$executeRaw`
    INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
    VALUES (${shptB}::uuid, ${progB}::uuid, 'DISPATCHED_BY_VENDOR', '2026-07-19T08:00:00Z'::timestamptz, 'BATCH_FILE', 'ref-b-1', 'trace-b')
  `

  return { shptA, shptB, progA, progB }
}

describe('tenant read API: readShipments / readShipmentStatusTrail (spec 10b, D-6)', () => {
  it('readShipments(db,[A]) returns only A\'s shipment', async () => {
    const { shptA, progA } = await seed()
    const rows = await readShipments(db, [progA])
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe(shptA)
    expect(r.awb).toBe('AWB-A-1')
    expect(r.status).toBe('IN_TRANSIT')
    expect(r.programId).toBe(progA)
    expect(r.courierPartner).toBeNull()
    expect(r.dispatchDate).toBeInstanceOf(Date)
    expect(r.createdAt).toBeInstanceOf(Date)
    expect(r.updatedAt).toBeInstanceOf(Date)
  })

  it('readShipments(db,[]) returns [] (fail-closed empty scope)', async () => {
    await seed()
    const rows = await readShipments(db, [])
    expect(rows).toEqual([])
  })

  it('readShipmentStatusTrail(db,[A], shptA) returns A\'s trail ordered ascending', async () => {
    const { shptA, progA } = await seed()
    const trail = await readShipmentStatusTrail(db, [progA], shptA)
    expect(trail).toHaveLength(2)
    expect(trail[0]!.status).toBe('PICKED_UP')
    expect(trail[1]!.status).toBe('OUT_FOR_DELIVERY')
    expect(trail[0]!.occurredAt.getTime()).toBeLessThan(trail[1]!.occurredAt.getTime())
    expect(trail[0]!.shptId).toBe(shptA)
    expect(trail[0]!.programId).toBe(progA)
    expect(trail[0]!.source).toBe('BATCH_FILE')
  })

  it('readShipmentStatusTrail(db,[], shptA) returns [] (fail-closed empty scope)', async () => {
    const { shptA } = await seed()
    const trail = await readShipmentStatusTrail(db, [], shptA)
    expect(trail).toEqual([])
  })

  it('readShipmentStatusTrail(db,[A], shptB) returns [] : B is out of scope', async () => {
    const { shptB, progA } = await seed()
    const trail = await readShipmentStatusTrail(db, [progA], shptB)
    expect(trail).toEqual([])
  })

  it('no-aggregate guard: read.ts contains no count(/group by(/sum( (check 7)', () => {
    const text = readFileSync('services/fulfillment/src/read.ts', 'utf8')
    expect(/\b(count|group\s+by|sum)\s*\(/i.test(text)).toBe(false)
  })

  it('C4 guard: read.ts and read-context.ts reference no other context (no "services/" substring)', () => {
    const readText = readFileSync('services/fulfillment/src/read.ts', 'utf8')
    const readContextText = readFileSync('services/fulfillment/src/read-context.ts', 'utf8')
    expect(readText.includes('services/')).toBe(false)
    expect(readContextText.includes('services/')).toBe(false)
  })
})
