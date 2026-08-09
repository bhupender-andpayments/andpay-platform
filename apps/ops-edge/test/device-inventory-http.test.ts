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

// Phase 5 Task 1 (D-G, FR-01a): the class-3 ops device-inventory upload edge.
// The REAL app, real in-process HTTP via supertest against
// app.getHttpServer(), exercising the full multipart mutation gate
// (mandatory Idempotency-Key, D2 authorize, co-committed ALLOW 6e) and the
// server-side manufacturer-vndr validation + strict 3-mandatory row parse.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-device-inventory-test-key-1'

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

const HEADER = 'Device ID,SIM No,Device QR'

function toCsv(rows: string[][]): Buffer {
  const lines = [HEADER, ...rows.map((r) => r.join(','))]
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}

async function seedVendor(type: string): Promise<string> {
  const wire = newId('vndr')
  await fulfillmentDb.$executeRaw`
    INSERT INTO vndr (id, type, display_name, status, updated_at)
    VALUES (${toUuid(wire)}::uuid, ${type}, 'CWD', 'ACTIVE', now())
  `
  return wire
}

async function fulfillmentOutboxAuthz(): Promise<{ decision: string; operation: string }[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: { decision: string; operation: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation }))
}

async function unitCount(): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
  return Number(rows[0]!.n)
}

async function ledgerRows(): Promise<
  { row_total: number; row_accepted: number; row_flagged: number; row_invalid: number; status: string }[]
> {
  return fulfillmentDb.$queryRaw`SELECT row_total, row_accepted, row_flagged, row_invalid, status FROM device_inventory_upload`
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
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE unit, intake_exception, device_inventory_upload, outbox, inbox')
})

describe('ops-edge uploads: device inventory (multipart, D-G)', () => {
  it('a class-3 upload creates units at IN_STOCK, reports a mandatory-field-missing row as invalid, writes the ledger row, and co-commits ONE ALLOW 6e', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const csv = toCsv([
      ['1234567890001', '8991000000000000101U', 'QR-1'],
      ['', '8991000000000000102U', 'QR-2'], // missing Device ID -> invalid, not ingested
    ])
    const token = await mint({})
    const idem = randomUUID()

    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem)
      .field('manufacturerVndrId', manufacturerVndr)
      .attach('file', csv, 'inventory.csv')

    expect(res.status).toBe(200)
    expect(res.body.accepted).toBe(1)
    expect(res.body.flagged).toBe(0)
    expect(res.body.invalid).toBe(1)
    expect(res.body.invalidRows).toEqual([{ rowNo: 2, errors: ['missing_device_id'] }])
    expect(res.body.fileId).toBe(idem)
    expect(res.body.deduped).toBe(false)

    expect(await unitCount()).toBe(1)
    const units = await fulfillmentDb.$queryRaw<{ status: string; product_type: string }[]>`
      SELECT status, product_type FROM unit WHERE device_serial = '1234567890001'`
    expect(units).toEqual([{ status: 'IN_STOCK', product_type: 'SOUNDBOX' }])

    const ledger = await ledgerRows()
    expect(ledger).toEqual([{ row_total: 2, row_accepted: 1, row_flagged: 0, row_invalid: 1, status: 'processed' }])

    const allow = await fulfillmentOutboxAuthz()
    expect(allow).toEqual([{ decision: 'ALLOW', operation: 'ops:upload-device-inventory' }])
  })

  it('an unknown manufacturerVndrId -> 404 via the OpsErrorFilter, no domain effect', async () => {
    const csv = toCsv([['1234567890009', '8991000000000000109U', 'QR-9']])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('manufacturerVndrId', newId('vndr'))
      .attach('file', csv, 'inventory.csv')
    expect(res.status).toBe(404)
    expect(await unitCount()).toBe(0)
  })

  it('rejects an unauthorized role with 403 + a durable DENY 6e, no domain effect', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const csv = toCsv([['1234567890001', '8991000000000000101U', 'QR-1']])
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('manufacturerVndrId', manufacturerVndr)
      .attach('file', csv, 'inventory.csv')
    expect(res.status).toBe(403)
    expect(await unitCount()).toBe(0)
    const deny = await fulfillmentOutboxAuthz()
    expect(deny).toHaveLength(1)
    expect(deny[0]).toEqual({ decision: 'DENY', operation: 'ops:upload-device-inventory' })
  })

  it('a request with NO Idempotency-Key -> 400 (not a 6e), no domain effect', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const csv = toCsv([['1234567890001', '8991000000000000101U', 'QR-1']])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .field('manufacturerVndrId', manufacturerVndr)
      .attach('file', csv, 'inventory.csv')
    expect(res.status).toBe(400)
    expect(await unitCount()).toBe(0)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)
  })

  // Fix round 1, Finding A: a wrong/missing header must be REJECTED at the
  // edge as a 400 (via the fulfillment domain's OpsClientError -> the
  // app-wide OpsErrorFilter), never a silent 200, and it must burn no
  // ledger row and emit no 6e.
  it('a file with the wrong header -> 400 via OpsErrorFilter, NO ledger row, NO 6e', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const wrongHeaderCsv = Buffer.from('Serial,ICCID,QR\n1234567890001,8991000000000000101U,QR-1\n', 'utf8')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('manufacturerVndrId', manufacturerVndr)
      .attach('file', wrongHeaderCsv, 'inventory.csv')
    expect(res.status).toBe(400)
    expect(await unitCount()).toBe(0)
    expect(await ledgerRows()).toHaveLength(0)
    expect(await fulfillmentOutboxAuthz()).toHaveLength(0)

    // Step 1 Task 3, and the disclosure contract that goes with it. The body
    // names the offending columns so the portal can tell the operator WHICH
    // column was wrong, but carries nothing caller-influenced: no uploaded
    // filename, no cell value, and not the domain error's own message (S4/5c,
    // OpsErrorFilter). Every required column is missing from this file, so all
    // three are reported.
    expect(res.body.code).toBe('invalid')
    expect(res.body.message).toBe('invalid request')
    const columns = (res.body.reasons as { code: string; column?: string }[]).map((r) => r.column).sort()
    expect(columns).toEqual(['Device ID', 'Device QR', 'Sim No'])
    for (const r of res.body.reasons as { code: string }[]) {
      expect(r.code).toBe('missing_required_column')
    }
    // The uploaded filename, the sheet's own header text and the internal
    // message must all be absent from the wire.
    const wire = JSON.stringify(res.body)
    expect(wire).not.toContain('inventory.csv')
    expect(wire).not.toContain('Serial')
    expect(wire).not.toContain('ICCID')
    expect(wire).not.toContain('structural parse')
  })

  // The other two structural codes carry a code and NO column, and must still
  // never leak the filename their internal message embeds.
  it('an unsupported extension -> 400 carrying the code only, filename never on the wire', async () => {
    const manufacturerVndr = await seedVendor('MANUFACTURER')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('manufacturerVndrId', manufacturerVndr)
      .attach('file', Buffer.from('anything', 'utf8'), 'devices.txt')
    expect(res.status).toBe(400)
    expect(res.body.reasons).toEqual([{ code: 'unsupported_extension' }])
    expect(JSON.stringify(res.body)).not.toContain('devices.txt')
    expect(await unitCount()).toBe(0)
  })

  // Fix round 1, Finding B: a malformed manufacturerVndrId must be a clean
  // 400 (OpsClientError, via the SAME OpsErrorFilter mapping), never an
  // uncaught InvalidIdError surfacing as a 500.
  it('a malformed manufacturerVndrId -> 400, not 500', async () => {
    const csv = toCsv([['1234567890001', '8991000000000000101U', 'QR-1']])
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/uploads/device-inventory')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('manufacturerVndrId', 'not-a-valid-id')
      .attach('file', csv, 'inventory.csv')
    expect(res.status).toBe(400)
    expect(await unitCount()).toBe(0)
    expect(await ledgerRows()).toHaveLength(0)
  })
})
