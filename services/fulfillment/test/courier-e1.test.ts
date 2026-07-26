import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { ingestStatusFile } from '../src/status-file.js'
import { advanceShipmentStatus } from '../src/courier-status.js'

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
afterAll(async () => {
  await db.$disconnect()
})

// Class-6 claim scoped to vendor_courier (mirrors status-file.test.ts's
// courierClaim, so shapes match exactly).
function courierClaim(vndrId: string, workQueue: string, overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-courier-e1-1',
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

describe('courier status advance atomicity (E1)', () => {
  it('check 10: the advance, the trail append, and the fact commit or roll back together (E1)', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))

    // ROLLBACK path: run the real advance inside a transaction we force to abort
    // AFTER it has done its writes. All three effects must roll back together.
    await expect(db.$transaction(async (tx) => {
      const outcome = await advanceShipmentStatus(tx, {
        awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: new Date('2026-07-26T10:00:00.000Z'),
        source: 'BATCH_FILE', sourceRef: 'v|f', traceId: 't',
      })
      expect(outcome).toBe('advanced') // it DID advance inside the tx
      throw new Error('force rollback')
    })).rejects.toThrow('force rollback')

    // Fresh reads: nothing persisted, status unadvanced.
    expect(await trailCount()).toBe(0)
    expect(await factCount()).toBe(0)
    expect(await statusOf('AWB1')).toBe('DISPATCHED_BY_VENDOR')

    // COMMIT path via the real adapter: all three present.
    const res = await ingestStatusFile(db, {
      fileId: 'e1-file', vndrId: vndrWire, workQueue: 'courier-status',
      rows: [{ awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }],
    }, claim, 't')
    expect(res.advanced).toBe(1)
    expect(await trailCount()).toBe(1)
    expect(await factCount()).toBe(1)
    expect(await statusOf('AWB1')).toBe('PICKED_UP')
  })
})
