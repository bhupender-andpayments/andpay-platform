import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { ingestStatusFile, type StatusFile } from '../src/status-file.js'

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

// Class-6 claim scoped to vendor_courier (mirrors return-sheet.test.ts's
// classSixClaim, but psr points at vendor_courier, the vendor set that carries
// 'shipment:submit-status' per authz-config.ts).
function courierClaim(vndrId: string, workQueue: string, overrides: Partial<LeanClaim> = {}): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: newId('api'),
    aud: 'andpay:vendor',
    iat: 1000,
    exp: 2000,
    nbf: 1000,
    jti: 'jti-status-file-1',
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

describe('batch courier status-file ingest', () => {
  it('advances a shipment through the ladder and emits a fact per transition (check 1)', async () => {
    const { vndrWire, claim } = await seedCourier()
    // bind the shipment cleanly to the submitting courier.
    await seedShipment('AWB1', toUuid(vndrWire))
    const res = await ingestStatusFile(db, file(vndrWire, [
      { awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB1', status: 'IN_TRANSIT', courierTimestamp: '2026-07-26T11:00:00.000Z' },
      { awb: 'AWB1', status: 'DELIVERED', courierTimestamp: '2026-07-26T12:00:00.000Z' },
    ]), claim, 'trace-sf-1')
    expect(res.rejected).toBeUndefined()
    expect(res.advanced).toBe(3)
    expect(await statusOf('AWB1')).toBe('DELIVERED')
    expect(await trailCount()).toBe(3)
    expect(await factCount()).toBe(3)
  })

  it('rejects the whole file when the submitter is not that vendor (unauthorized, zero writes)', async () => {
    const { vndrWire } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const foreign = courierClaim('vndr_someoneelse', 'courier-status')
    const res = await ingestStatusFile(db, file(vndrWire, [{ awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }]), foreign, 't')
    expect(res.rejected).toBe('unauthorized')
    expect(await trailCount()).toBe(0)
    expect(await factCount()).toBe(0)
  })

  it('rejects the whole file on a shape violation (schema_invalid, zero writes)', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const res = await ingestStatusFile(db, file(vndrWire, [
      { awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: 'not-a-date' },
    ]), claim, 't')
    expect(res.rejected).toBe('schema_invalid')
    expect(await trailCount()).toBe(0)
  })

  it('quarantines per row: unknown AWB, wrong courier, unassigned, unknown status (checks 3+4)', async () => {
    const { vndrWire, claim } = await seedCourier()
    const other = await seedCourier('DELHIVERY', 'courier-status')
    await seedShipment('AWB-OK', toUuid(vndrWire))               // belongs to submitter
    await seedShipment('AWB-OTHER', toUuid(other.vndrWire))      // belongs to a different courier
    await seedShipment('AWB-NULL', null)                          // never bound
    const res = await ingestStatusFile(db, file(vndrWire, [
      { awb: 'AWB-OK', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB-MISSING', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB-OTHER', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB-NULL', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' },
      { awb: 'AWB-OK', status: 'BANANA', courierTimestamp: '2026-07-26T11:00:00.000Z' },
    ]), claim, 't')
    expect(res.rejected).toBeUndefined()
    expect(res.advanced).toBe(1)         // only AWB-OK PICKED_UP
    expect(res.quarantined).toBe(4)
    const q = await exceptions()
    expect(q.every((x) => x.channel === 'BATCH_FILE')).toBe(true)
    const byReason = new Map(q.map((x) => [x.subject_ref + '|' + x.reason_code, true]))
    expect(byReason.has('AWB-MISSING|unknown_awb')).toBe(true)
    expect(byReason.has('AWB-OTHER|wrong_courier')).toBe(true)
    expect(byReason.has('AWB-NULL|courier_unassigned')).toBe(true)
    expect(byReason.has('AWB-OK|unknown_status')).toBe(true)
    expect(await statusOf('AWB-OK')).toBe('PICKED_UP')
  })

  it('is file-idempotent: a replay of the same vendor|fileId is a no-op', async () => {
    const { vndrWire, claim } = await seedCourier()
    await seedShipment('AWB1', toUuid(vndrWire))
    const rows = [{ awb: 'AWB1', status: 'PICKED_UP', courierTimestamp: '2026-07-26T10:00:00.000Z' }]
    const r1 = await ingestStatusFile(db, file(vndrWire, rows, 'dup-file'), claim, 't')
    expect(r1.deduped).toBe(false)
    const r2 = await ingestStatusFile(db, file(vndrWire, rows, 'dup-file'), claim, 't')
    expect(r2.deduped).toBe(true)
    expect(await trailCount()).toBe(1)
    expect(await factCount()).toBe(1)
  })
})
