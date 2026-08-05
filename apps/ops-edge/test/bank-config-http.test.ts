import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId } from '@andpay/ids'
import {
  PrismaClient as FulfillmentClient,
  loadOpsConfig,
  InMemoryAssetStore,
} from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, MAX_UPLOAD_BYTES, type OpsEdgeDeps } from '../src/index.js'

// Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
// admin CRUD HTTP surface. The REAL app, real in-process HTTP via supertest,
// mirroring ops-actions-http.test.ts's / uploads-http.test.ts's own shape
// (per-action gate: Idempotency-Key -> D2 authorize -> co-committed ALLOW 6e;
// the multipart logo route additionally mirrors uploads-http.test.ts's
// FileInterceptor + size-cap + 413 posture).
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-bank-config-test-key-1'

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
  reasonCode: string | undefined
  resourceIds: string[] | undefined
  principalId: string
}

async function auditRowsFor(operation: string): Promise<AuditRow[]> {
  const rows = await fulfillmentDb.$queryRaw<
    {
      payload: {
        decision: string
        operation: string
        reasonCode?: string
        resourceIds?: string[]
        principalId: string
      }
    }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows
    .filter((r) => r.payload.operation === operation)
    .map((r) => ({
      decision: r.payload.decision,
      operation: r.payload.operation,
      reasonCode: r.payload.reasonCode,
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
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE bank_composition_config, outbox, inbox CASCADE')
})

describe('POST /ops/bank-config (Phase 3 Task 5b)', () => {
  it('a valid upsert -> 200, row created, one ALLOW 6e', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        tenantWire,
        bankCode: 'HDFC',
        branchCode: 'BR-100',
        brandingParams: { primaryColor: '#ff0000' },
        imageTemplates: { SOUNDBOX: {} },
      })
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(typeof res.body.id).toBe('string')

    const rows = await auditRowsFor('ops:template-config-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([res.body.id])
  })

  it('missing Idempotency-Key -> 400, no 6e', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantWire, bankCode: 'HDFC', brandingParams: {}, imageTemplates: {} })
    expect(res.status).toBe(400)
    expect(await auditRowsFor('ops:template-config-set')).toHaveLength(0)
  })

  it('a class-3 claim whose psr resolves to no ops role -> 403 + one DENY 6e, no domain effect', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ tenantWire, bankCode: 'HDFC', brandingParams: {}, imageTemplates: {} })
    expect(res.status).toBe(403)

    const rows = await auditRowsFor('ops:template-config-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('unknown-role')

    const n = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM bank_composition_config`
    expect(Number(n[0]!.n)).toBe(0)
  })
})

describe('GET /ops/bank-config (guard-only read)', () => {
  it('returns configured rows, no 6e emitted', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint()
    await request(app.getHttpServer())
      .post('/ops/bank-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ tenantWire, bankCode: 'HDFC', branchCode: 'BR-200', brandingParams: { x: 1 }, imageTemplates: {} })

    const res = await request(app.getHttpServer())
      .get('/ops/bank-config')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.some((r: { bankCode: string; branchCode: string }) => r.bankCode === 'HDFC' && r.branchCode === 'BR-200')).toBe(
      true,
    )
  })

  it('an unauthenticated request -> 401 (guard-only, still requires a valid claim)', async () => {
    const res = await request(app.getHttpServer()).get('/ops/bank-config')
    expect(res.status).toBe(401)
  })
})

describe('POST /ops/bank-config/logo (multipart, Phase 3 Task 5b)', () => {
  it('a valid logo upload -> 200, logoMasterRef persisted, one ALLOW 6e carrying the version', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config/logo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('tenantWire', tenantWire)
      .field('bankCode', 'HDFC')
      .field('branchCode', 'BR-300')
      .attach('file', Buffer.from('%fake-ai-logo-bytes%'), 'logo.ai')
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(typeof res.body.reference).toBe('string')
    expect(typeof res.body.version).toBe('string')

    const row = await fulfillmentDb.$queryRaw<{ logo_master_ref: string | null }[]>`
      SELECT logo_master_ref FROM bank_composition_config WHERE id = ${res.body.id}::uuid
    `
    expect(row[0]!.logo_master_ref).toBe(res.body.reference)

    const rows = await auditRowsFor('ops:bank-logo-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.resourceIds).toEqual([res.body.id, `logo-version:${res.body.version}`])
  })

  it('missing file -> 400', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config/logo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('tenantWire', tenantWire)
      .field('bankCode', 'HDFC')
    expect(res.status).toBe(400)
  })

  it('an oversized file -> 413 (the MAX_UPLOAD_BYTES cap, same as the bank/damage sheet uploads)', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint()
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1)
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config/logo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('tenantWire', tenantWire)
      .field('bankCode', 'HDFC')
      .attach('file', oversized, 'logo.ai')
    expect(res.status).toBe(413)
  })

  it('a class-3 claim whose psr resolves to no ops role -> 403 + one DENY 6e, no domain effect', async () => {
    const tenantWire = newId('tnnt')
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/bank-config/logo')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .field('tenantWire', tenantWire)
      .field('bankCode', 'HDFC')
      .attach('file', Buffer.from('bytes'), 'logo.ai')
    expect(res.status).toBe(403)

    const rows = await auditRowsFor('ops:bank-logo-set')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')

    const n = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM bank_composition_config`
    expect(Number(n[0]!.n)).toBe(0)
  })
})
