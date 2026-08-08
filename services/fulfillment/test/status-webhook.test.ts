import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { ingestStatusWebhook, passthroughMapper } from '../src/status-webhook.js'

const url = process.env.FULFILLMENT_DATABASE_URL
  ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const PROGRAM = toUuid(newId('prog'))
const TENANT = toUuid(newId('tnnt'))

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, vndr, outbox, inbox CASCADE',
  )
})
// Truncating ONLY in beforeEach leaves whatever the FINAL test inserted sitting
// in the database for the rest of the gate and beyond (F-9, F-9b). That is not
// theoretical here: this suite's own 'AWB1' shipment was found alive in the demo
// database, and the courier credential rows outlived the run too. A test fixture
// is not demo data and must not outlive the test.
afterAll(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, vndr, outbox, inbox CASCADE',
  )
  await db.$disconnect()
})

// Class-6 claim scoped to vendor_courier (mirrors status-file.test.ts's courierClaim).
function courierClaim(vndrId: string, workQueue: string, overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-status-webhook-1',
    cls: 6,
    mode: 'test',
    scope: { vndr: vndrId, wq: workQueue },
    psr: 'vset:vendor_courier',
    epoch: 1,
    ...overrides,
  }
}

async function seedCourier(code = 'BLUEDART', wq = 'courier-status'): Promise<{ vndrWire: string; claim: LeanClaim }> {
  const vndrUuid = toUuid(newId('vndr'))
  await db.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, courier_code, updated_at)
    VALUES (${vndrUuid}::uuid, 'COURIER', 'Blue Dart', 'ACTIVE', ${code}, now())
  `
  const vndrWire = fromUuid('vndr', vndrUuid)
  const claim = courierClaim(vndrWire, wq)
  return { vndrWire, claim }
}

async function seedShipment(awb: string, courierPartnerUuid: string | null): Promise<void> {
  await db.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(newId('shpt'))}::uuid, ${awb}, ${courierPartnerUuid}::uuid, 'DISPATCHED_BY_VENDOR', now(), ${TENANT}::uuid, ${PROGRAM}::uuid, now())
  `
}

async function statusOf(awb: string): Promise<string> {
  const r = await db.$queryRaw<{ status: string }[]>`SELECT status FROM shpt WHERE awb = ${awb}`
  return r[0]!.status
}
async function trailCount(): Promise<number> {
  const r = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM shpt_status_event`
  return Number(r[0]!.c)
}
async function factCount(): Promise<number> {
  const r = await db.$queryRaw<{ c: bigint }[]>`SELECT count(*) AS c FROM outbox WHERE event_type = 'fct.fulfillment.shipment.v1'`
  return Number(r[0]!.c)
}
async function exceptions(): Promise<{ channel: string; subject_ref: string; reason_code: string }[]> {
  return db.$queryRaw`SELECT channel, subject_ref, reason_code FROM courier_status_exception ORDER BY created_at ASC`
}

describe('generic authenticated courier webhook handler', () => {
  it('advances a shipment from a single authenticated webhook push (check 1 webhook channel)', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const res = await ingestStatusWebhook(db, {
      vndrId: vndrWire, workQueue: 'courier-status', eventId: 'evt-1',
      awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z',
    }, claim, 'trace-wh-1')
    expect(res.rejected).toBeUndefined()
    expect(res.outcome).toBe('advanced')
    expect(await statusOf('AWB1')).toBe('PICKED_UP')
    expect(await trailCount()).toBe(1)
    expect(await factCount()).toBe(1)
  })

  it('dedups a re-delivered webhook on {vendor}|{eventId}', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const ev = { vndrId: vndrWire, workQueue: 'courier-status', eventId: 'evt-dup', awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }
    expect((await ingestStatusWebhook(db, ev, claim, 't')).outcome).toBe('advanced')
    expect((await ingestStatusWebhook(db, ev, claim, 't')).outcome).toBe('deduped')
    expect(await trailCount()).toBe(1)
    expect(await factCount()).toBe(1)
  })

  it('maps a cross-channel inner-transition dedup to deduped, not quarantined (I1 fix)', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const ts = '2026-07-26T10:00:00.000Z'
    const first = await ingestStatusWebhook(db, {
      vndrId: vndrWire, workQueue: 'courier-status', eventId: 'e-a',
      awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: ts,
    }, claim, 't')
    expect(first.outcome).toBe('advanced')

    // Same awb + same status + same courierTimestamp, but a FRESH eventId, so
    // the outer {vendor}|{eventId} inbox guard does NOT dedup; only the inner
    // per-(shpt,status,ts) key in advanceShipmentStatus does.
    const second = await ingestStatusWebhook(db, {
      vndrId: vndrWire, workQueue: 'courier-status', eventId: 'e-b',
      awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: ts,
    }, claim, 't')
    expect(second.outcome).toBe('deduped')
    expect(second.outcome).not.toBe('quarantined')
    expect(await exceptions()).toHaveLength(0)
    expect(await trailCount()).toBe(1)
    expect(await factCount()).toBe(1)
  })

  it('rejects a cross-vendor webhook (unauthorized, zero writes)', async () => {
    const { vndrWire } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const foreign = { cls: 6, psr: 'vset:vendor_courier', scope: { vndr: 'vndr_other', wq: 'courier-status' } } as unknown as LeanClaim
    const res = await ingestStatusWebhook(db, { vndrId: vndrWire, workQueue: 'courier-status', eventId: 'e', awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }, foreign, 't')
    expect(res.rejected).toBe('unauthorized')
    expect(await trailCount()).toBe(0)
  })

  it('rejects an unmappable payload (schema_invalid) via the passthrough mapper', async () => {
    const { claim } = await seedCourier()
    const res = await ingestStatusWebhook(db, { garbage: true }, claim, 't')
    expect(res.rejected).toBe('schema_invalid')
    expect(await trailCount()).toBe(0)
  })

  it('quarantines a foreign-courier webhook per row with channel WEBHOOK', async () => {
    const { vndrWire, claim } = await seedCourier()
    const other = await seedCourier('DELHIVERY')
    await seedShipment('AWB-OTHER', toUuid(other.vndrWire))
    const res = await ingestStatusWebhook(db, { vndrId: vndrWire, workQueue: 'courier-status', eventId: 'e2', awb: 'AWB-OTHER', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }, claim, 't')
    expect(res.outcome).toBe('quarantined')
    const q = await exceptions()
    expect(q).toHaveLength(1)
    expect(q[0]!.channel).toBe('WEBHOOK')
    expect(q[0]!.reason_code).toBe('wrong_courier')
  })

  it('exposes a passthrough mapper seam and builds NO HTTP surface (check 6)', async () => {
    const { readFileSync } = await import('node:fs')
    expect(typeof ingestStatusWebhook).toBe('function')
    expect(typeof passthroughMapper).toBe('function')
    // The webhook is a pure handler; the HTTP transport is a step-9 deferral.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const httpFw of ['@nestjs/core', '@nestjs/common', 'express', 'fastify']) {
      expect(Object.keys(deps)).not.toContain(httpFw)
    }
  })
})
