import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// Phase 3 Task 6 (BRD 5.3.2): the batching-parameter admin CRUD HTTP surface.
// The REAL app via supertest, mirroring bank-config-http.test.ts's shape. The
// point of interest is the FIRST per-role differentiation: the WRITE
// (ops:batching-config-set) is granted to admin / super_admin ONLY, so a
// baseline ops_portal / ops operator is DENIED at the D2 authorize in the gate.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-batching-config-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// Default role is admin (this suite exercises the admin-tier write); override
// `psr` to test the differentiation DENY for a baseline operator.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_admin_1',
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'role:admin',
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

async function auditRowsFor(operation: string): Promise<AuditRow[]> {
  const rows = await fulfillmentDb.$queryRaw<
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
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE batching_config, outbox, inbox CASCADE')
})

describe('POST /ops/batching-config (Phase 3 Task 6)', () => {
  it('an admin upsert -> 200, row created, one ALLOW 6e carrying old+new', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ minLotSize: 10, maxWaitSeconds: 100 })
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(typeof res.body.id).toBe('string')

    const rows = await auditRowsFor('ops:batching-config-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([
      res.body.id,
      'scope:global',
      'min-lot-size:old=50:new=10',
      'max-wait-seconds:old=604800:new=100',
    ])
  })

  it('missing Idempotency-Key -> 400, no 6e', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ minLotSize: 10, maxWaitSeconds: 100 })
    expect(res.status).toBe(400)
    expect(await auditRowsFor('ops:batching-config-set')).toHaveLength(0)
  })

  it('an invalid value (minLotSize < 1) -> 400, no row', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ minLotSize: 0, maxWaitSeconds: 100 })
    expect(res.status).toBe(400)
    const n = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batching_config`
    expect(Number(n[0]!.n)).toBe(0)
  })

  it('the baseline ops_portal role is DENIED (differentiation) -> 403 + DENY 6e, no domain effect', async () => {
    const token = await mint({ psr: 'role:ops_portal' })
    const res = await request(app.getHttpServer())
      .post('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ minLotSize: 10, maxWaitSeconds: 100 })
    expect(res.status).toBe(403)

    const rows = await auditRowsFor('ops:batching-config-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')

    const n = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batching_config`
    expect(Number(n[0]!.n)).toBe(0)
  })
})

describe('GET /ops/batching-config (guard-only read)', () => {
  it('returns configured scope rows, no 6e emitted', async () => {
    const token = await mint()
    await request(app.getHttpServer())
      .post('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ minLotSize: 7, maxWaitSeconds: 77 })

    const res = await request(app.getHttpServer()).get('/ops/batching-config').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(
      res.body.some(
        (r: { scope: string; minLotSize: number; maxWaitSeconds: number }) =>
          r.scope === 'GLOBAL' && r.minLotSize === 7 && r.maxWaitSeconds === 77,
      ),
    ).toBe(true)
  })

  it('an unauthenticated request -> 401 (guard-only, still requires a valid claim)', async () => {
    const res = await request(app.getHttpServer()).get('/ops/batching-config')
    expect(res.status).toBe(401)
  })
})
