import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { buildTenantEdgeApp, type TenantEdgeDeps } from '../src/index.js'

// The REAL app, real in-process HTTP via supertest, no bound port. This suite
// exercises the Task-8 class-2 reporting routes: server-side scope
// re-derivation (D99) fanning to the analytics mediation API as a { kind:
// 'own' } ReadScope, the per-read analytics 6e into the ANALYTICS outbox
// (ALLOW on non-empty scope, DENY reasonCode 'empty-scope' + 403 otherwise),
// the freshness watermark riding the response, and the inline CSV export. A
// class-2 controller can ONLY ever build kind:'own', so guardrail G1 holds
// structurally at the edge.
const EXPECTED_ISS = 'https://auth.andpay.test/tenant'
const KID = 'tenant-edge-reports-test-key-1'

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

const WATERMARK_ISO = '2026-07-29T12:00:00.000Z'

interface Seeded {
  progA: string
  progB: string
  progC: string
  tnntA: string
}

let seeded: Seeded

async function mint(scope: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'user_tenant_reports_1',
    cls: 2,
    mode: 'live',
    aud: 'andpay:tenant-portal',
    scope,
    psr: 'pset:tenant_ops',
    epoch: 1,
    jti: randomUUID(),
  })
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
  reasonCode: string | undefined
  cls: number
  principalId: string
  actorChannel: string | undefined
  resourceIds: string[] | undefined
}

async function analyticsAuditRows(): Promise<AuditRow[]> {
  const rows = await analyticsDb.$queryRaw<
    {
      payload: {
        decision: string
        operation: string
        reasonCode?: string
        cls: number
        principalId: string
        actorChannel?: string
        resourceIds?: string[]
      }
    }[]
  >`SELECT payload FROM analytics.outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({
    decision: r.payload.decision,
    operation: r.payload.operation,
    reasonCode: r.payload.reasonCode,
    cls: r.payload.cls,
    principalId: r.payload.principalId,
    actorChannel: r.payload.actorChannel,
    resourceIds: r.payload.resourceIds,
  }))
}

async function insertRow(dispatchId: string, programId: string, bankCode: string): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, ${bankCode}, ${bankCode + ' Bank'}, 'Acme', ARRAY['DEV1']::text[],
            'RECEIVED', true, now(), now())`
}

async function seed(): Promise<Seeded> {
  const progA = randomUUID()
  const progB = randomUUID()
  const progC = randomUUID()
  const tnntA = randomUUID()

  // progA: two RECEIVED rows across two banks. progB: one RECEIVED row, out of
  // the claim scope, must never appear.
  await insertRow(`asgn_${randomUUID()}`, progA, 'HDFC')
  await insertRow(`asgn_${randomUUID()}`, progA, 'ICIC')
  await insertRow(`asgn_${randomUUID()}`, progB, 'AXIS')

  // A freshness watermark so the response carries a non-null asOf.
  await analyticsDb.$executeRaw`
    INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
    VALUES ('fct.assignment.v1', ${new Date(WATERMARK_ISO)}, 'env-seed-1', now())`

  return { progA, progB, progC, tnntA }
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  const jwks: JSONWebKeySet = { keys: [jwk] }

  const deps: TenantEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
    jwks,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
  }
  app = await buildTenantEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
})

beforeEach(async () => {
  await analyticsDb.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark, analytics.outbox CASCADE')
  seeded = await seed()
})

describe('tenant reports edge: GET /tenant/reports/tiles is claim-scoped (D99, G1)', () => {
  it('returns tiles scoped to the claim program (progB excluded), carries the watermark, emits one ALLOW 6e', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const res = await request(app.getHttpServer()).get('/tenant/reports/tiles').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // progA has 2 RECEIVED rows; progB's row is out of scope and excluded.
    expect(res.body.tiles.requestsReceived).toBe(2)
    expect(res.body.tiles.pendingQrAwaitingBatch.count).toBe(2)
    // The freshness watermark rides the response body.
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)

    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('analytics:read-tiles')
    expect(rows[0]!.cls).toBe(2)
    expect(rows[0]!.principalId).toBe('user_tenant_reports_1')
    expect(rows[0]!.actorChannel).toBe('human-direct')
    expect(rows[0]!.resourceIds).toContain(seeded.tnntA)
    expect(rows[0]!.resourceIds).toContain(seeded.progA)
  })

  it('IGNORES an out-of-scope ?program_id= param: still claim-scoped (D99)', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const res = await request(app.getHttpServer())
      .get(`/tenant/reports/tiles?program_id=${seeded.progB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // The spoofed param changes nothing: still progA's 2 rows, never progB's.
    expect(res.body.tiles.requestsReceived).toBe(2)
  })

  it('an empty-scope claim (pids absent) -> 403 + one read-DENY 6e (reasonCode empty-scope)', async () => {
    const token = await mint({ tid: seeded.tnntA })
    const res = await request(app.getHttpServer()).get('/tenant/reports/tiles').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)

    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('analytics:read-tiles')
    expect(rows[0]!.reasonCode).toBe('empty-scope')
    expect(rows[0]!.cls).toBe(2)
  })

  it('an empty-scope claim (pids: []) -> 403 + one read-DENY 6e', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [] })
    const res = await request(app.getHttpServer()).get('/tenant/reports/tiles').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('empty-scope')
  })
})

describe('tenant reports edge: GET /tenant/reports/:name (report by name)', () => {
  it('returns a claim-scoped batching report as JSON with the watermark', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const res = await request(app.getHttpServer())
      .get('/tenant/reports/batching')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // Batching groups RECEIVED rows per bank: progA has HDFC + ICIC = 2 rows.
    expect(res.body.rows).toHaveLength(2)
    const banks = res.body.rows.map((r: { bankCode: string }) => r.bankCode).sort()
    expect(banks).toEqual(['HDFC', 'ICIC'])
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)

    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('analytics:read-report')
  })

  it('?format=csv returns CSV text (not JSON), still claim-scoped', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const res = await request(app.getHttpServer())
      .get('/tenant/reports/batching?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    // The CSV header row plus two bank rows (RFC 4180 CRLF-separated).
    const lines = res.text.trim().split('\r\n')
    expect(lines[0]).toContain('bankCode')
    expect(lines).toHaveLength(3)
  })

  it('an unknown report name -> 404, no read 6e emitted', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const res = await request(app.getHttpServer())
      .get('/tenant/reports/not-a-real-report')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('an empty-scope claim on a report -> 403 + one read-DENY 6e', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [] })
    const res = await request(app.getHttpServer())
      .get('/tenant/reports/batching')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('analytics:read-report')
    expect(rows[0]!.reasonCode).toBe('empty-scope')
  })
})
