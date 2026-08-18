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

// The list-form sibling of batch-journey-route.test.ts's per-batch suite
// (GET /ops/reports/batch-journey/:btchId). Same app boot, same token
// minting, same seeding idiom, and the same audit-count assertion style,
// this time against the bulk rollup route GET /ops/reports/batch-journey.
const EXPECTED_ISS = 'https://auth.andpay.test'
const KID = 'test-kid-journey-summaries'
const WATERMARK_ISO = '2026-08-11T09:00:00.000Z'

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
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
const BATCH = `btch_${randomUUID().replace(/-/g, '')}`

async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_journey_2',
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

describe('GET /ops/reports/batch-journey', () => {
  it('401s without a token', async () => {
    const res = await request(app.getHttpServer()).get('/ops/reports/batch-journey')
    expect(res.status).toBe(401)
  })

  it('lists per-batch rollups with one audit pair and a watermark header', async () => {
    const prog = randomUUID()
    await insertRow(prog, BATCH, 'DELIVERED')
    await insertRow(prog, BATCH, 'SENT_TO_VENDOR')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batch-journey')
      .set('authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.headers['x-analytics-watermark']).toBeTruthy()
    expect(Array.isArray(res.body.rows)).toBe(true)
    const row = res.body.rows.find((r: { batchId: string }) => r.batchId === BATCH)
    expect(row).toBeTruthy()
    expect(row.counts.total).toBe(2)

    // Guardrail G3: exactly one 6e pair (per-read 6e plus the distinct
    // cross-tenant-access entry) for the single call, mirroring the per-batch
    // route's assertion.
    expect(await analyticsAuditCount()).toBe(2)
  })

  it('returns an empty rows array when there are no batches', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batch-journey')
      .set('authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.rows).toEqual([])
  })

  it('rejects a class-2 token: this is a class-3 edge by construction', async () => {
    const token = await mint({ cls: 2, aud: 'andpay:tenant-portal' })
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batch-journey')
      .set('authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})
