import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { loadOpsConfig, PrismaClient as FulfillmentClient, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'
import { newId } from '@andpay/ids'

// The REAL app, real in-process HTTP via supertest, no bound port. This suite
// exercises the Task-8 class-3 reporting routes: the class-3 ops actor derived
// from the VERIFIED claim (D99) fanning to the analytics mediation API as a
// { kind: 'crossTenant' } ReadScope (guardrail G1: only a class-3 edge can
// build crossTenant), the per-read analytics 6e AND the D99 cross-tenant-access
// entry (guardrail G3), the presentation ?bank= filter (legitimate, unlike a
// scope-spoofing ?program_id=), the freshness watermark riding the response,
// and the inline CSV export.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-reports-test-key-1'

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

const WATERMARK_ISO = '2026-07-29T12:00:00.000Z'

interface Seeded {
  progA: string
  progB: string
}

// Mint a live class-3 internal-admin access token carrying an EMPTY scope (no
// pids), exactly as a real class-3 claim does: the ops actor is cross-tenant by
// design, so scope is re-derived to { kind: 'crossTenant' } from cls alone.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_reports_1',
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

// Task 4 (D-H.2/FR-10): a DELIVERED, not-yet-activated row carrying multiple
// device ids, so the activation report route can be asserted against a row
// that actually exercises the Device ID(s) column (the shared seed() rows are
// all RECEIVED and never enter the activation worklist).
async function insertDeliveredRow(dispatchId: string, programId: string, bankCode: string): Promise<void> {
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, delivery_date, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, ${bankCode}, ${bankCode + ' Bank'}, 'Acme',
            ARRAY['SB-DEV-1','SB-DEV-2']::text[], 'DELIVERED', true, now(), now(), now())`
}

async function seed(): Promise<Seeded> {
  const progA = randomUUID()
  const progB = randomUUID()

  // Two programs, three banks across them, so a crossTenant read sees the union
  // and a ?bank= filter narrows it.
  await insertRow(`asgn_${randomUUID()}`, progA, 'HDFC')
  await insertRow(`asgn_${randomUUID()}`, progA, 'ICIC')
  await insertRow(`asgn_${randomUUID()}`, progB, 'AXIS')

  await analyticsDb.$executeRaw`
    INSERT INTO analytics_watermark (topic, as_of, envelope_id, updated_at)
    VALUES ('fct.assignment.v1', ${new Date(WATERMARK_ISO)}, 'env-seed-1', now())`

  return { progA, progB }
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
})

beforeEach(async () => {
  await analyticsDb.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark, analytics.outbox CASCADE')
  await seed()
})

describe('ops reports edge: GET /ops/reports/tiles sees the cross-tenant union (D99, G1/G3)', () => {
  it('a class-3 token sees the union of both programs, carries the watermark, emits BOTH the 6e AND the cross-tenant entry', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer()).get('/ops/reports/tiles').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // crossTenant: progA (2) + progB (1) = 3 RECEIVED rows.
    expect(res.body.tiles.requestsReceived).toBe(3)
    expect(res.body.tiles.pendingQrAwaitingBatch.count).toBe(3)
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)

    const rows = await analyticsAuditRows()
    // Guardrail G3: BOTH the per-read 6e AND the distinct cross-tenant-access entry.
    expect(rows).toHaveLength(2)
    const perRead = rows.find((r) => r.operation === 'analytics:read-tiles')
    const crossTenant = rows.find((r) => r.operation === 'analytics:cross-tenant-read')
    expect(perRead).toBeDefined()
    expect(crossTenant).toBeDefined()
    expect(perRead!.cls).toBe(3)
    expect(perRead!.principalId).toBe('user_ops_reports_1')
    expect(perRead!.actorChannel).toBe('human-direct')
    expect(crossTenant!.decision).toBe('ALLOW')
    expect(crossTenant!.resourceIds).toEqual([])
  })
})

describe('ops reports edge: GET /ops/reports/:name with the ?bank= filter (G3)', () => {
  it('the ?bank=HDFC filter narrows the cross-tenant batching report; emits both audit entries', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batching?bank=HDFC')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // Cross-tenant batching over all banks is 3; ?bank=HDFC narrows to 1.
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0].bankCode).toBe('HDFC')
    expect(res.body.watermark.asOf).toBe(WATERMARK_ISO)

    const rows = await analyticsAuditRows()
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.operation === 'analytics:read-report')).toBe(true)
    expect(rows.some((r) => r.operation === 'analytics:cross-tenant-read')).toBe(true)
  })

  it('?format=csv returns the cross-tenant report as CSV text', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/batching?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const lines = res.text.trim().split('\r\n')
    expect(lines[0]).toContain('bankCode')
    // Header plus three bank rows across the union (HDFC, ICIC, AXIS).
    expect(lines).toHaveLength(4)
  })

  it('an unknown report name -> 404', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/not-a-real-report')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('ops reports edge: GET /ops/reports/activation carries Device ID(s) (Task 4, D-H.2/FR-10)', () => {
  it('JSON returns the deviceIds column and format=csv includes it, Pattern-B audit unchanged', async () => {
    const progA = randomUUID()
    const worklistId = `asgn_${randomUUID()}`
    await insertDeliveredRow(worklistId, progA, 'HDFC')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/activation')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0].dispatchId).toBe(worklistId)
    expect(res.body.rows[0].deviceIds).toEqual(['SB-DEV-1', 'SB-DEV-2'])
    expect(res.body.rows[0].activationStatus).toBeNull()

    // Pattern B (Decision-2, RULED): still exactly the two unconditional
    // accounting 6e rows, no new permission, no DENY branch.
    const auditRows = await analyticsAuditRows()
    expect(auditRows).toHaveLength(2)
    expect(auditRows.some((r) => r.operation === 'analytics:read-report')).toBe(true)
    expect(auditRows.some((r) => r.operation === 'analytics:cross-tenant-read')).toBe(true)
    expect(auditRows.every((r) => r.decision === 'ALLOW')).toBe(true)
  })

  it('?format=csv includes the deviceIds column, semicolon-joined', async () => {
    const progA = randomUUID()
    const worklistId = `asgn_${randomUUID()}`
    await insertDeliveredRow(worklistId, progA, 'HDFC')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/activation?format=csv')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const lines = res.text.trim().split('\r\n')
    expect(lines[0]).toContain('deviceIds')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('SB-DEV-1;SB-DEV-2')

    const auditRows = await analyticsAuditRows()
    expect(auditRows).toHaveLength(2)
  })
})

describe('ops-edge FR-03/FR-04 dispatch-package download (Phase 4 Task 4a, P4-D6)', () => {
  it('GET excel/:group for a batch returns a sorted .xlsx (PK zip), per group', async () => {
    const token = await mint()
    for (const group of ['SOUNDBOX', 'COLLATERAL']) {
      const res = await request(app.getHttpServer())
        .get(`/ops/batches/${newId('btch')}/excel/${group}`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => callback(null, Buffer.concat(chunks)))
        })
      expect(res.status).toBe(200)
      // xlsx is a PK zip container.
      const body = res.body as Buffer
      expect(body.subarray(0, 2).toString('latin1')).toBe('PK')
    }
  })

  it('GET excel/:group accepts the legacy artifact-type keys and 404s an unknown one', async () => {
    const token = await mint()
    const legacy = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/excel/STICKER_IMG`)
      .set('Authorization', `Bearer ${token}`)
    expect(legacy.status).toBe(200)
    const unknown = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/excel/NOT_A_GROUP`)
      .set('Authorization', `Bearer ${token}`)
    expect(unknown.status).toBe(404)
  })

  it('GET collateral/:type for a batch with no such artifact -> 404', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/collateral/SOUNDBOX_IMG`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})
