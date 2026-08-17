import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId } from '@andpay/ids'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// The ops Add-merchant HTTP surface (POST /ops/merchants, 2026-08-17), mirroring
// bank-master-http.test.ts. The ALLOW 6e lands in IDENTITY's outbox (the write is
// an identity-context function called with deps.identityDb); a gate DENY stays
// edge-emitted into fulfillment's outbox, so the two are read from different DBs.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-merchant-create-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const identityUrl =
  process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({ datasourceUrl: identityUrl })

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_1',
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

interface AuditRow {
  decision: string
  operation: string
  resourceIds: string[] | undefined
  principalId: string
}

async function auditFor(
  db: { $queryRaw: IdentityClient['$queryRaw'] },
  operation: string,
): Promise<AuditRow[]> {
  const rows = await db.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[]; principalId: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({
      decision: r.payload.decision,
      operation: r.payload.operation,
      resourceIds: r.payload.resourceIds,
      principalId: r.payload.principalId,
    }))
}

const identityAuditFor = (op: string): Promise<AuditRow[]> => auditFor(identityDb, op)
const fulfillmentAuditFor = (op: string): Promise<AuditRow[]> =>
  auditFor(fulfillmentDb as unknown as { $queryRaw: IdentityClient['$queryRaw'] }, op)

// Create the Bank Master the merchant will be sponsored by, through its own
// route, so the fixture uses the same door an operator does.
async function seedBank(token: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/ops/bank-masters')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      bankReferenceCode: `BREF-${randomUUID().slice(0, 8)}`,
      displayName: 'GSCB',
      address1: '1 MG Road',
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      country: 'India',
      pin: '560001',
      mobile: '9000000001',
      email: 'ops@gscb.example',
    })
  expect(res.status).toBe(200)
  return res.body.tnntId as string
}

function body(tnntWire: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tnntWire,
    displayName: 'SUNRISE HARDWARE',
    legalName: 'Sunrise Hardware Pvt Ltd',
    mcc: '5251',
    vpa: `sunrise-${randomUUID().slice(0, 8)}@gscb`,
    contactName: 'Asha Rao',
    mobile: '9000000002',
    email: 'asha@sunrise.example',
    address: '12 Station Road',
    city: 'Rajkot',
    state: 'Gujarat',
    pincode: '360001',
    ...overrides,
  }
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
  await identityDb.$executeRawUnsafe(
    'TRUNCATE sub_merchant, merchant, merchant_bank_ref, tenant, program, enrollment, outbox, inbox',
  )
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox CASCADE')
})

describe('POST /ops/merchants (the ops Add-merchant write)', () => {
  it('a valid create -> 200 with the wire mrchId, and one ALLOW 6e in the identity outbox', async () => {
    const token = await mint()
    const tnntWire = await seedBank(token)

    const res = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body(tnntWire))

    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(res.body.mrchId).toMatch(/^mrch_/)

    const audit = await identityAuditFor('ops:merchant-create')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    expect(audit[0]!.resourceIds).toEqual([res.body.mrchId])
  })

  it('missing Idempotency-Key -> 400, no 6e', async () => {
    const token = await mint()
    const tnntWire = await seedBank(token)

    const res = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .send(body(tnntWire))

    expect(res.status).toBe(400)
    expect(await identityAuditFor('ops:merchant-create')).toHaveLength(0)
  })

  it('a duplicate VPA for the same bank -> 400', async () => {
    const token = await mint()
    const tnntWire = await seedBank(token)
    const dup = body(tnntWire, { vpa: 'duplicate@gscb' })

    const first = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(dup)
    expect(first.status).toBe(200)

    const second = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(dup)
    expect(second.status).toBe(400)
  })

  // A WELL-FORMED tnnt id that no bank master holds, so this exercises the
  // not-found branch. A malformed id is a different answer (400 below).
  it('a well-formed but unknown bank -> 404', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body(newId('tnnt')))

    expect(res.status).toBe(404)
  })

  it('a malformed bank id -> 400', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body('tnnt_not-a-real-id'))

    expect(res.status).toBe(400)
  })

  it('a class-3 claim whose psr resolves to no ops role -> 403 + one DENY 6e, no merchant', async () => {
    const setup = await mint()
    const tnntWire = await seedBank(setup)

    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body(tnntWire))
    expect(res.status).toBe(403)

    const deny = await fulfillmentAuditFor('ops:merchant-create')
    expect(deny).toHaveLength(1)
    expect(deny[0]!.decision).toBe('DENY')

    const n = await identityDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM merchant`
    expect(Number(n[0]!.n)).toBe(0)
  })

  // customer_support carries exactly one mutation (ops:flag-damage) by design,
  // so adding a merchant must 403 for it by omission, not by a special case.
  it('the customer_support role -> 403', async () => {
    const setup = await mint()
    const tnntWire = await seedBank(setup)

    const token = await mint({ psr: 'role:customer_support' })
    const res = await request(app.getHttpServer())
      .post('/ops/merchants')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body(tnntWire))
    expect(res.status).toBe(403)
  })
})
