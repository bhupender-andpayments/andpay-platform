import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { newId, toUuid } from '@andpay/ids'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// T5.1, D-17 (13 Aug 2026): the class-3 ops COURIER-STATUS upload edge. The
// REAL app, real in-process HTTP via supertest, exercising the full multipart
// mutation gate (mandatory Idempotency-Key, D2 authorize, co-committed ALLOW 6e)
// and the server-side courier-vndr validation. The domain rules themselves are
// pinned in services/fulfillment/test/ops-courier-status.test.ts; what is
// asserted here is that the ROUTE is wired, gated and shaped correctly.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-courier-status-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({
  datasourceUrl: process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// Mint a live class-3 internal-admin access token. `sub` defaults to a REAL
// raw uuid (not the other suites' opaque 'user_ops_1' literal): this route
// persists the actor id into device_inventory_upload.uploader::uuid, exactly
// like every other actor column in this context (held_by_actor,
// released_by_actor, ...), so the test's actor must be a genuine uuid.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: randomUUID(),
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'role:ops_portal',
    epoch: 1,
    jti: randomUUID(),
    acr: 'AAL2',
    auth_time: now,
    ...overrides,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KID })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .setIssuer(EXPECTED_ISS)
    .sign(privateKey)
}

const HEADER = 'AWB,Status,Status Date'

function toCsv(rows: string[][]): Buffer {
  const lines = [HEADER, ...rows.map((r) => r.join(','))]
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

async function seedShipment(awb: string, courierWire: string | null): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(newId('shpt'))}::uuid, ${awb}, ${courierWire === null ? null : toUuid(courierWire)}::uuid,
            'DISPATCHED_BY_VENDOR', now(), ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid, now())
  `
}

async function statusOf(awb: string): Promise<string> {
  const r = await fulfillmentDb.$queryRaw<{ status: string }[]>`SELECT status FROM shpt WHERE awb = ${awb}`
  return r[0]!.status
}

async function seedVendor(type: string): Promise<string> {
  const wire = newId('vndr')
  await fulfillmentDb.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${toUuid(wire)}::uuid, ${type}, 'Blue Dart', 'ACTIVE', now())
  `
  return wire
}

async function fulfillmentOutboxAuthz(): Promise<{ decision: string; operation: string }[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: { decision: string; operation: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation }))
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  const jwks: JSONWebKeySet = { keys: [jwk] }

  const deps: OpsEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
    identityDb,
    jwks,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
    roleConfig: loadOpsConfig(),
    portalOrigin: 'https://ops.andpay.test',
    assetStore: new InMemoryAssetStore(),
  }
  app = await buildOpsEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
  await identityDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, pending_pool_entry, vndr, outbox, inbox CASCADE',
  )
})

describe('ops-edge uploads: courier status (multipart, D-17)', () => {
  it('a class-3 upload advances the named shipments and co-commits ONE ALLOW 6e', async () => {
    const courier = await seedVendor('COURIER')
    await seedShipment('AWB-E1', courier)

    const res = await request(app.getHttpServer())
      .post('/ops/uploads/courier-status')
      .set('Authorization', `Bearer ${await mint()}`)
      .set('Idempotency-Key', randomUUID())
      .field('courierVndrId', courier)
      .attach('file', toCsv([['AWB-E1', 'DELIVERED', '2026-08-12']]), 'morning.csv')

    expect(res.status).toBe(200)
    expect(res.body.advanced).toBe(1)
    expect(res.body.quarantined).toBe(0)
    expect(res.body.deduped).toBe(false)
    expect(await statusOf('AWB-E1')).toBe('DELIVERED')

    const audit = await fulfillmentOutboxAuthz()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toEqual({ decision: 'ALLOW', operation: 'ops:upload-courier-status' })
  })

  it('a missing Idempotency-Key is a 400 before anything happens', async () => {
    const courier = await seedVendor('COURIER')
    await seedShipment('AWB-E2', courier)

    const res = await request(app.getHttpServer())
      .post('/ops/uploads/courier-status')
      .set('Authorization', `Bearer ${await mint()}`)
      .field('courierVndrId', courier)
      .attach('file', toCsv([['AWB-E2', 'DELIVERED', '2026-08-12']]), 'morning.csv')

    expect(res.status).toBe(400)
    expect(await statusOf('AWB-E2')).toBe('DISPATCHED_BY_VENDOR')
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)
  })

  it('a token whose role lacks the permission is a 403 with a DENY 6e and no effect', async () => {
    const courier = await seedVendor('COURIER')
    await seedShipment('AWB-E3', courier)

    const res = await request(app.getHttpServer())
      .post('/ops/uploads/courier-status')
      .set('Authorization', `Bearer ${await mint({ psr: 'role:nothing' })}`)
      .set('Idempotency-Key', randomUUID())
      .field('courierVndrId', courier)
      .attach('file', toCsv([['AWB-E3', 'DELIVERED', '2026-08-12']]), 'morning.csv')

    expect(res.status).toBe(403)
    expect(await statusOf('AWB-E3')).toBe('DISPATCHED_BY_VENDOR')
    const audit = await fulfillmentOutboxAuthz()
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('DENY')
  })

  it('a missing file is a 400, not a 500', async () => {
    const courier = await seedVendor('COURIER')
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/courier-status')
      .set('Authorization', `Bearer ${await mint()}`)
      .set('Idempotency-Key', randomUUID())
      .field('courierVndrId', courier)

    expect(res.status).toBe(400)
  })

  it('a structural parse failure is a 4xx naming the missing COLUMN and never the filename (S4/5c)', async () => {
    const courier = await seedVendor('COURIER')
    const bad = Buffer.from('AWB,Status\nAWB-E4,DELIVERED\n', 'utf8')

    const res = await request(app.getHttpServer())
      .post('/ops/uploads/courier-status')
      .set('Authorization', `Bearer ${await mint()}`)
      .set('Idempotency-Key', randomUUID())
      .field('courierVndrId', courier)
      .attach('file', bad, 'secret-customer-list.csv')

    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('Status Date')
    // The operator's filename must never ride an HTTP response.
    expect(JSON.stringify(res.body)).not.toContain('secret-customer-list')
  })

  it('a vendor that is not a COURIER is a 4xx, with no shipment touched', async () => {
    const manufacturer = await seedVendor('MANUFACTURER')
    await seedShipment('AWB-E5', null)

    const res = await request(app.getHttpServer())
      .post('/ops/uploads/courier-status')
      .set('Authorization', `Bearer ${await mint()}`)
      .set('Idempotency-Key', randomUUID())
      .field('courierVndrId', manufacturer)
      .attach('file', toCsv([['AWB-E5', 'DELIVERED', '2026-08-12']]), 'morning.csv')

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(await statusOf('AWB-E5')).toBe('DISPATCHED_BY_VENDOR')
  })

  it('a replayed Idempotency-Key returns deduped and advances nothing a second time', async () => {
    const courier = await seedVendor('COURIER')
    await seedShipment('AWB-E6', courier)
    const key = randomUUID()

    const token = await mint()
    const send = () =>
      request(app.getHttpServer())
        .post('/ops/uploads/courier-status')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .field('courierVndrId', courier)
        .attach('file', toCsv([['AWB-E6', 'DELIVERED', '2026-08-12']]), 'morning.csv')

    const first = await send()
    const second = await send()

    expect(first.body.deduped).toBe(false)
    expect(first.body.advanced).toBe(1)
    expect(second.body.deduped).toBe(true)
    expect(second.body.advanced).toBe(0)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(1)
  })
})
