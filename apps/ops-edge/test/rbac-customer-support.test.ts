import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// The D-29 boundary, end to end over HTTP (DAMAGE_PLAN B6, DP-8, DP-9): a
// customer_support principal CAN flag damage (its one mutation) and CAN read
// the working surfaces (dispatches, by-vpa, damage cases, summary, JSON report
// views), and CANNOT reach any upload commit, any upload preview, any binary
// download, any CSV export, or either config view. The principal is minted
// directly as a signed claim with psr 'role:customer_support' (the pattern
// mark-activated-http.test.ts uses for support_readonly; DP-12: no
// operator-creation endpoint exists, provisioning is direct insert). The last
// test proves the restriction does NOT leak onto a full ops role.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-rbac-cs-test-key-1'

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

// A live class-3 internal-admin token. psr defaults to the CS role under test;
// the leak-check test overrides it back to the full ops role.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: randomUUID(),
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'role:customer_support',
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

async function fulfillmentAuditRows(): Promise<{ decision: string; operation: string; reasonCode?: string }[]> {
  const rows = await fulfillmentDb.$queryRaw<
    { payload: { decision: string; operation: string; reasonCode?: string } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation, reasonCode: r.payload.reasonCode }))
}

// Same single-leg seed as flag-damage-http.test.ts: the flaggable dispatch.
async function seedLeg(): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  await tmsDb.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', ${'x-' + randomUUID() + '@hdfcbank'},
    true, 0, 0, true, 'pooled-for-fulfillment', ${'file-' + randomUUID()}, 'SOUNDBOX', now()
  )`
  return { asgnWire, asgnUuid }
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
  await tmsDb.$executeRawUnsafe('TRUNCATE assignment, outbox, inbox CASCADE')
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox CASCADE')
})

describe('customer_support CAN do its one job (D-29)', () => {
  it('POST flag-damage -> 201: ops:flag-damage is granted to the role', async () => {
    const { asgnWire } = await seedLeg()
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'battery_issue', remarks: 'merchant reports no sound' })
    expect(res.status).toBe(201)
    expect(res.body.caseStatus).toBe('Open')
  })

  it('the working reads stay open: dispatches/by-vpa, damage-cases, damage-cases/summary -> 200', async () => {
    const token = await mint()
    const byVpa = await request(app.getHttpServer())
      .get('/ops/dispatches/by-vpa')
      .query({ vpa: 'acme@hdfcbank' })
      .set('Authorization', `Bearer ${token}`)
    expect(byVpa.status).toBe(200)
    expect(Array.isArray(byVpa.body.rows)).toBe(true)

    const cases = await request(app.getHttpServer()).get('/ops/damage-cases').set('Authorization', `Bearer ${token}`)
    expect(cases.status).toBe(200)
    expect(Array.isArray(cases.body)).toBe(true)

    const summary = await request(app.getHttpServer())
      .get('/ops/damage-cases/summary')
      .set('Authorization', `Bearer ${token}`)
    expect(summary.status).toBe(200)
    expect(summary.body).toEqual({ open: expect.any(Number), inProgress: expect.any(Number), closed: expect.any(Number) })
  })

  it('the JSON report view stays open: GET /ops/reports/soundbox-delivery (no format=csv) -> 200', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .get('/ops/reports/soundbox-delivery')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('customer_support CANNOT mutate beyond the flag (permission-denied at the D2 gate)', () => {
  // Every upload commit. The gate's D2 authorize runs BEFORE the missing-file
  // check, so no fixture file is needed to prove the 403; the Idempotency-Key
  // is set so the request reaches the authorize rather than 400ing first.
  it('every upload commit -> 403 with a permission-denied DENY 6e (the role resolved; the permission is absent)', async () => {
    const token = await mint()
    const commits = [
      '/ops/uploads/bank/commit',
      '/ops/uploads/device-inventory',
      '/ops/uploads/courier-status',
      '/ops/uploads/unit-status',
      '/ops/uploads/return',
      '/ops/uploads/activation',
    ]
    for (const path of commits) {
      const res = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
      expect(res.status, path).toBe(403)
    }
    const denies = await fulfillmentAuditRows()
    expect(denies).toHaveLength(commits.length)
    for (const row of denies) {
      expect(row.decision).toBe('DENY')
      // permission-denied, NOT unknown-role: the role exists in OPS_ROLES and
      // simply does not hold the operation, which is the D-29 design.
      expect(row.reasonCode).toBe('permission-denied')
    }
  })

  it('every upload preview -> 403 (DP-9: the three formerly-ungated previews now run authorizePreview)', async () => {
    const token = await mint()
    for (const path of [
      '/ops/uploads/bank/preview',
      '/ops/uploads/device-inventory/preview',
      '/ops/uploads/unit-status/preview',
      '/ops/uploads/return/preview',
    ]) {
      const res = await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`)
      expect(res.status, path).toBe(403)
    }
  })

  it('POST batching-config -> 403 (admin-tier write, never granted to CS)', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ minLotSize: 5 })
    expect(res.status).toBe(403)
  })
})

describe('customer_support CANNOT download, export, or view config (DP-8 edge deny list)', () => {
  it('the batch Excel and collateral downloads -> 403 before any resolution', async () => {
    const token = await mint()
    const btch = newId('btch')
    const excel = await request(app.getHttpServer())
      .get(`/ops/batches/${btch}/excel/SOUNDBOX`)
      .set('Authorization', `Bearer ${token}`)
    expect(excel.status).toBe(403)

    const pdf = await request(app.getHttpServer())
      .get(`/ops/batches/${btch}/collateral/COLLATERAL`)
      .set('Authorization', `Bearer ${token}`)
    expect(pdf.status).toBe(403)
  })

  it('report format=csv -> 403 while the SAME report without format=csv is 200', async () => {
    const token = await mint()
    const csv = await request(app.getHttpServer())
      .get('/ops/reports/soundbox-delivery')
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${token}`)
    expect(csv.status).toBe(403)

    const json = await request(app.getHttpServer())
      .get('/ops/reports/soundbox-delivery')
      .set('Authorization', `Bearer ${token}`)
    expect(json.status).toBe(200)
  })

  it('GET bank-config and GET batching-config -> 403 (config views)', async () => {
    const token = await mint()
    const bank = await request(app.getHttpServer()).get('/ops/bank-config').set('Authorization', `Bearer ${token}`)
    expect(bank.status).toBe(403)
    const batching = await request(app.getHttpServer())
      .get('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
    expect(batching.status).toBe(403)
  })
})

describe('the restriction must not leak onto full roles', () => {
  it('an ops-role principal still gets 200 on a download (an unknown batch resolves to an EMPTY sheet, not a 403)', async () => {
    const token = await mint({ psr: 'role:ops_portal' })
    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}/excel/SOUNDBOX`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml')
  })

  it('an ops-role principal still reads both config views (200)', async () => {
    const token = await mint({ psr: 'role:ops_portal' })
    const bank = await request(app.getHttpServer()).get('/ops/bank-config').set('Authorization', `Bearer ${token}`)
    expect(bank.status).toBe(200)
    const batching = await request(app.getHttpServer())
      .get('/ops/batching-config')
      .set('Authorization', `Bearer ${token}`)
    expect(batching.status).toBe(200)
  })
})
