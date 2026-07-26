import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { ingestStatusFile, type StatusFile } from '../src/status-file.js'
import { type ShipmentFactPayload } from '../src/events.js'

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
// courierClaim, so this file's ingest chain runs under the same authz shape
// as the committed batch-file suite).
function courierClaim(vndrId: string, workQueue: string, overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-courier-checks-1',
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

function file(vndrWire: string, rows: StatusFile['rows'], fileId = 'sf-1', wq = 'courier-status'): StatusFile {
  return { fileId, vndrId: vndrWire, workQueue: wq, rows }
}

describe('courier status trace chain (check 9)', () => {
  it('the ingest trace_id appears on BOTH the trail row and the emitted fact', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const TRACE = 'trace-courier-chain-xyz'
    await ingestStatusFile(db, file(vndrWire, [
      { awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
    ], 'sf-trace'), claim, TRACE)

    const trail = await db.$queryRaw<{ trace_id: string }[]>`SELECT trace_id FROM shpt_status_event WHERE status = 'PICKED_UP'`
    expect(trail[0]!.trace_id).toBe(TRACE)
    const fact = await db.$queryRaw<{ payload: Envelope<ShipmentFactPayload> }[]>`SELECT payload FROM outbox WHERE event_type = 'fct.fulfillment.shipment.v1'`
    expect(fact[0]!.payload.traceId).toBe(TRACE)
    // check 9 residency/PII: the fact carries no shipping PII, only ids/status/ts
    const keys = Object.keys(fact[0]!.payload.payload).sort()
    expect(keys).not.toContain('shipToAddress')
    expect(keys).not.toContain('contactName')
    expect(keys).not.toContain('mobile')
  })
})

describe('no money in the fulfillment schema (check 8)', () => {
  it('the fulfillment schema has no ledger, account, entry, or posting tables', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'fulfillment' AND table_type = 'BASE TABLE'
    `
    const names = rows.map((r) => r.table_name)
    for (const money of ['ledger', 'accounts', 'entries', 'posting_keys', 'journal', 'postings']) {
      expect(names).not.toContain(money)
    }
    // positive control: the courier tables this spec added ARE present
    expect(names).toContain('shpt_status_event')
    expect(names).toContain('courier_status_exception')
  })
})
