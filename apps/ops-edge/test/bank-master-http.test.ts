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

// Phase 3 Task 7 (BRD Annexure D): the Bank Master admin CRUD HTTP surface,
// mirroring bank-config-http.test.ts. The ALLOW 6e for a Bank Master write lands
// in IDENTITY's own outbox (the write is an identity-context function called
// with deps.identityDb); a gate DENY 6e stays edge-emitted into fulfillment's
// outbox (emitOpsAuthzAudit's sink), so the two are read from different DBs.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-bank-master-test-key-1'

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

async function identityAuditFor(operation: string): Promise<AuditRow[]> {
  const rows = await identityDb.$queryRaw<
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

async function fulfillmentAuditFor(operation: string): Promise<AuditRow[]> {
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

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bankReferenceCode: `BREF-${randomUUID().slice(0, 8)}`,
    displayName: 'HDFC Bank',
    address1: '1 MG Road',
    city: 'Bengaluru',
    district: 'Bengaluru Urban',
    country: 'India',
    pin: '560001',
    mobile: '9000000001',
    email: 'ops@hdfc.example',
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
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox, bank_composition_config CASCADE')
})

describe('POST /ops/bank-masters (Phase 3 Task 7)', () => {
  it('a valid create -> 200, row created, one ALLOW 6e in identity outbox', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'BREF-HTTP-1' }))
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(typeof res.body.tnntId).toBe('string')

    const audit = await identityAuditFor('ops:bank-master-create')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.decision).toBe('ALLOW')
    expect(audit[0]!.resourceIds).toEqual([res.body.tnntId])
  })

  it('missing Idempotency-Key -> 400, no 6e', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .send(body())
    expect(res.status).toBe(400)
    expect(await identityAuditFor('ops:bank-master-create')).toHaveLength(0)
  })

  it('a duplicate bankReferenceCode -> 400 (OpsClientError mapped by OpsErrorFilter)', async () => {
    const token = await mint()
    const dup = body({ bankReferenceCode: 'BREF-DUP-1' })
    const first = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(dup)
    expect(first.status).toBe(200)
    const second = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(dup)
    expect(second.status).toBe(400)
  })

  it('a class-3 claim whose psr resolves to no ops role -> 403 + one DENY 6e (fulfillment outbox), no domain effect', async () => {
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body())
    expect(res.status).toBe(403)

    const deny = await fulfillmentAuditFor('ops:bank-master-create')
    expect(deny).toHaveLength(1)
    expect(deny[0]!.decision).toBe('DENY')

    const n = await identityDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tenant`
    expect(Number(n[0]!.n)).toBe(0)
  })
})

describe('POST /ops/bank-masters/:id/edit (Phase 3 Task 7)', () => {
  it('edits displayName/address/status -> 200, row updated, one ALLOW 6e with changed-field tokens', async () => {
    const token = await mint()
    const created = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'BREF-EDIT-1' }))
    expect(created.status).toBe(200)
    const tnntId = created.body.tnntId as string

    const res = await request(app.getHttpServer())
      .post(`/ops/bank-masters/${tnntId}/edit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ displayName: 'HDFC Bank Ltd', city: 'Mumbai', status: 'SUSPENDED' })
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(res.body.changedFields.sort()).toEqual(['city', 'displayName', 'status'])

    // resolve by bank_reference_code (stable) to avoid a wire->uuid decode in SQL
    const row = await identityDb.$queryRaw<
      { display_name: string; city: string; status: string; bank_reference_code: string }[]
    >`SELECT display_name, city, status, bank_reference_code FROM tenant WHERE bank_reference_code = 'BREF-EDIT-1'`
    const r = row[0]!
    expect(r.display_name).toBe('HDFC Bank Ltd')
    expect(r.city).toBe('Mumbai')
    expect(r.status).toBe('SUSPENDED')
    expect(r.bank_reference_code).toBe('BREF-EDIT-1') // immutable, unchanged

    const audit = await identityAuditFor('ops:bank-master-edit')
    expect(audit).toHaveLength(1)
    expect(audit[0]!.resourceIds).toEqual(
      expect.arrayContaining([tnntId, 'changed:displayName', 'changed:city', 'changed:status']),
    )
  })

  it('a not-found target -> 400 (OpsClientError mapped by OpsErrorFilter)', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/bank-masters/${newId('tnnt')}/edit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ displayName: 'ghost' })
    // a valid-but-absent tnnt id -> OpsClientError('not-found') -> 404 via
    // OpsErrorFilter (never a 200, never a 500).
    expect(res.status).toBe(404)
  })
})

describe('GET /ops/bank-masters (guard-only read)', () => {
  it('returns configured Bank Masters, no 6e emitted', async () => {
    const token = await mint()
    await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'BREF-LIST-1', displayName: 'ICICI' }))

    const res = await request(app.getHttpServer()).get('/ops/bank-masters').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.some((b: { bankReferenceCode: string }) => b.bankReferenceCode === 'BREF-LIST-1')).toBe(true)
  })

  it('an unauthenticated request -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/ops/bank-masters')
    expect(res.status).toBe(401)
  })
})

describe('bank master hierarchy over HTTP', () => {
  it('creates a child via parentBankReferenceCode and lists parentTnntId + hasLogo', async () => {
    const tok = await mint()
    const parent = await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'GSCB-T5' }))
      .expect(200)
    await request(app.getHttpServer())
      .post('/ops/bank-masters')
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'VSC-T5', displayName: 'VSC Bank', parentBankReferenceCode: 'GSCB-T5' }))
      .expect(200)
    const list = await request(app.getHttpServer())
      .get('/ops/bank-masters')
      .set('Authorization', `Bearer ${tok}`)
      .expect(200)
    const child = (list.body as { bankReferenceCode: string; parentTnntId: string | null; hasLogo: boolean }[]).find(
      (r) => r.bankReferenceCode === 'VSC-T5',
    )!
    expect(child.parentTnntId).toBe(parent.body.tnntId)
    expect(child.hasLogo).toBe(false)
  })

  it('rejects a parent that is itself a child with a 400', async () => {
    const tok = await mint()
    await request(app.getHttpServer()).post('/ops/bank-masters').set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID()).send(body({ bankReferenceCode: 'GSCB-T5B' })).expect(200)
    await request(app.getHttpServer()).post('/ops/bank-masters').set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'VSC-T5B', parentBankReferenceCode: 'GSCB-T5B' })).expect(200)
    await request(app.getHttpServer()).post('/ops/bank-masters').set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .send(body({ bankReferenceCode: 'DEEP-T5B', parentBankReferenceCode: 'VSC-T5B' })).expect(400)
  })
})

describe('bank master logo over HTTP', () => {
  it('uploads the master+derivative pair, then lists versions and streams the derivative', async () => {
    const tok = await mint()
    const created = await request(app.getHttpServer()).post('/ops/bank-masters').set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID()).send(body({ bankReferenceCode: 'LOGO-T5' })).expect(200)
    const tnntId = created.body.tnntId as string

    const upload = await request(app.getHttpServer())
      .post(`/ops/bank-masters/${tnntId}/logo`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .attach('master', Buffer.from('%!PS-Adobe ai bytes'), { filename: 'logo.ai', contentType: 'application/postscript' })
      .attach('derivative', Buffer.from('png bytes'), { filename: 'logo.png', contentType: 'image/png' })
      .expect(200)
    expect(upload.body.masterVersion).not.toBeNull()

    const versions = await request(app.getHttpServer())
      .get(`/ops/bank-masters/${tnntId}/logo/versions`)
      .set('Authorization', `Bearer ${tok}`)
      .expect(200)
    expect(versions.body).toHaveLength(1)
    expect(versions.body[0].filename).toBe('logo.ai')

    const derivative = await request(app.getHttpServer())
      .get(`/ops/bank-masters/${tnntId}/logo/derivative`)
      .set('Authorization', `Bearer ${tok}`)
      .expect(200)
    expect(derivative.headers['content-type']).toContain('image/png')

    const list = await request(app.getHttpServer()).get('/ops/bank-masters').set('Authorization', `Bearer ${tok}`).expect(200)
    expect(list.body.find((r: { bankReferenceCode: string }) => r.bankReferenceCode === 'LOGO-T5').hasLogo).toBe(true)
  })

  it('rejects a wrong-type derivative with a 400 and a missing file with a 400', async () => {
    const tok = await mint()
    const created = await request(app.getHttpServer()).post('/ops/bank-masters').set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID()).send(body({ bankReferenceCode: 'LOGO-T5B' })).expect(200)
    const tnntId = created.body.tnntId as string
    await request(app.getHttpServer())
      .post(`/ops/bank-masters/${tnntId}/logo`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .attach('master', Buffer.from('ai'), { filename: 'logo.ai', contentType: 'application/postscript' })
      .attach('derivative', Buffer.from('exe'), { filename: 'logo.exe', contentType: 'application/octet-stream' })
      .expect(400)
    await request(app.getHttpServer())
      .post(`/ops/bank-masters/${tnntId}/logo`)
      .set('Authorization', `Bearer ${tok}`)
      .set('Idempotency-Key', randomUUID())
      .attach('master', Buffer.from('ai'), { filename: 'logo.ai', contentType: 'application/postscript' })
      .expect(400)
    await request(app.getHttpServer())
      .get(`/ops/bank-masters/${tnntId}/logo/derivative`)
      .set('Authorization', `Bearer ${tok}`)
      .expect(404)
  })
})
