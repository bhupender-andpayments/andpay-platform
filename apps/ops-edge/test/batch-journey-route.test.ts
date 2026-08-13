import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { SignJWT, generateKeyPair, exportJWK, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { loadOpsConfig, PrismaClient as FulfillmentClient, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

const EXPECTED_ISS = 'https://auth.andpay.test'
const KID = 'test-kid-journey'
const WATERMARK_ISO = '2026-08-11T09:00:00.000Z'

// EVERY client takes an explicit datasourceUrl with a local fallback, the idiom all
// six sibling ops-edge http suites use. These were bare `new XClient()` calls, which
// read the env var directly, and CI sets IDENTITY / TMS / FULFILLMENT / ORCHESTRATOR
// but NOT ANALYTICS_DATABASE_URL (.github/workflows/ci.yml). So this suite could
// never pass in CI: all eight of its tests died on
// "Environment variable not found: ANALYTICS_DATABASE_URL" the first time the full
// gate was run against it. The same defect was caught and fixed once already, in
// services/analytics/test/batch-journey.test.ts; this is its twin, in the file
// nobody re-checked.
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const tmsDb = new TmsClient({
  datasourceUrl: process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms',
})
const fulfillmentDb = new FulfillmentClient({
  datasourceUrl:
    process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment',
})
const identityDb = new IdentityClient({
  datasourceUrl:
    process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

let app: INestApplication
// Inferred from generateKeyPair, the way all six sibling ops-edge http suites
// declare it. A bare `CryptoKey` is a DOM global that the root tsconfig's lib
// does not carry, so it failed `pnpm typecheck` (and therefore CI) outright.
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
const BATCH = `btch_${randomUUID().replace(/-/g, '')}`

async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_journey_1',
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

async function insertRow(programId: string, batchId: string | null, pipelineState: string): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       batch_id, pipeline_state, billable_flag, received_at, updated_at)
    VALUES (${`asgn_${randomUUID()}`}, ${programId}::uuid, 'HDFC', 'HDFC Bank', 'Acme',
            ARRAY['DEV1']::text[], ${batchId}, ${pipelineState}, true, now(), now())`
}

async function analyticsAuditCount(): Promise<number> {
  const rows = await analyticsDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM analytics.outbox`
  return Number(rows[0]!.n)
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
  await Promise.all([analyticsDb.$disconnect(), tmsDb.$disconnect(), fulfillmentDb.$disconnect(), identityDb.$disconnect()])
})

beforeEach(async () => {
  await analyticsDb.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark, analytics.outbox CASCADE')
  await analyticsDb.$executeRaw`
    INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
    VALUES ('fct.assignment.v1', ${new Date(WATERMARK_ISO)}, 'env-1', now())`
})

describe('GET /ops/reports/batch-journey/:btchId', () => {
  it('401s without a token', async () => {
    const res = await request(app.getHttpServer()).get(`/ops/reports/batch-journey/${BATCH}`)
    expect(res.status).toBe(401)
  })

  it('404s a batch with no rows rather than returning an empty-looking body', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('returns the rollup, the watermark body field, and the watermark header', async () => {
    const prog = randomUUID()
    await insertRow(prog, BATCH, 'DELIVERED')
    await insertRow(prog, BATCH, 'SENT_TO_VENDOR')
    // A different batch must never leak in.
    await insertRow(prog, `btch_${randomUUID().replace(/-/g, '')}`, 'DELIVERED')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.batchId).toBe(BATCH)
    expect(res.body.counts.total).toBe(2)
    expect(res.body.counts.delivered).toBe(1)
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)
    expect(res.headers['x-analytics-watermark']).toBe(WATERMARK_ISO)
  })

  it('reports simActivated as null on the wire, never 0', async () => {
    const prog = randomUUID()
    // D-16 (T4.3): 'ACTIVATED' is no longer a pipeline_state. This route only
    // needs a row in the batch at all, so it uses the fulfillment axis value it
    // would really carry.
    await insertRow(prog, BATCH, 'DELIVERED')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.body.activation.simActivated).toBeNull()
  })

  // Guardrail G3: a cross-tenant analytics read emits BOTH the per-read 6e and
  // the distinct cross-tenant-access entry. This is why the route lives on
  // ReportsController and not on OpsReadController, which is pinned to zero.
  it('emits the analytics 6e AND the cross-tenant-access entry, before the read', async () => {
    const prog = randomUUID()
    await insertRow(prog, BATCH, 'DELIVERED')
    const token = await mint()
    await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}`)
      .set('Authorization', `Bearer ${token}`)
    expect(await analyticsAuditCount()).toBe(2)
  })

  // D99: the edge derives scope from the claim, so a spoofed program param
  // changes nothing. A class-3 claim carries an empty scope by construction.
  it('IGNORES a caller-supplied program param', async () => {
    const prog = randomUUID()
    const other = randomUUID()
    await insertRow(prog, BATCH, 'DELIVERED')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}?program_id=${other}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.counts.total).toBe(1)
  })

  it('rejects a class-2 token: this is a class-3 edge by construction', async () => {
    const token = await mint({ cls: 2, aud: 'andpay:tenant-portal' })
    const res = await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  // Route ordering: /ops/reports/:name is a live one-segment route. A
  // two-segment path must not be captured by it, exactly as tiles/:tile is not.
  it('is not swallowed by the /ops/reports/:name report route', async () => {
    const prog = randomUUID()
    await insertRow(prog, BATCH, 'DELIVERED')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/reports/batch-journey/${BATCH}`)
      .set('Authorization', `Bearer ${token}`)
    // A report route would have 404ed on the unknown name 'batch-journey'.
    expect(res.status).toBe(200)
    expect(res.body.batchId).toBe(BATCH)
  })
})
