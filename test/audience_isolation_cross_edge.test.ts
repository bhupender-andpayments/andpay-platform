import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { JSONWebKeySet } from 'jose'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import {
  PrismaClient as AuthClient,
  type AuthDb,
  type KmsSigningPort,
  LocalEs256Adapter,
  TotpAdapter,
  loadConfig,
  issueAccessToken,
  INTERNAL_ADMIN_PLANE,
  VENDOR_PLANE,
} from '@andpay/auth-service'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { buildAuthEdgeApp, type AuthEdgeDeps, NoThrottle as AuthNoThrottle } from '@andpay/auth-edge'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '@andpay/ops-edge'
import { buildTenantEdgeApp, type TenantEdgeDeps } from '@andpay/tenant-edge'
import { buildVendorAuthEdgeApp, type VendorAuthEdgeDeps, NoThrottle as VendorAuthNoThrottle } from '@andpay/vendor-auth-edge'
import { buildEdgeApp as buildVendorIntakeEdgeApp, type EdgeDeps as VendorIntakeEdgeDeps } from '@andpay/vendor-edge'

// -----------------------------------------------------------------------------
// Spec 14a task 14 (LOAD-BEARING, check 8): the cross-edge audience-isolation
// proof. Five edges (auth-edge, ops-edge, tenant-edge, vendor-auth-edge,
// vendor-edge) each pin their OWN `expectedAud`/`expectedPlane`. This suite
// proves that pin is real: a token that WOULD verify at a given edge (its
// signing key IS published in that edge's JWKS, its issuer matches) is still
// rejected purely on `aud` (or the cls guard) when presented at the WRONG
// plane's edge.
//
// The critical test-construction requirement (per the task-8/13 note): every
// app built below shares ONE multi-key signer (`sharedSigner`, Fork D's
// `LocalEs256Adapter.createMulti`) and is wired with the SAME aggregated JWKS
// (`sharedJwks`, both the internal-admin and vendor public keys) and the SAME
// pinned issuer (`SHARED_ISS`). So when a `cls:7 aud:andpay:vendor` token is
// rejected at auth-edge/ops-edge/tenant-edge, or an `aud:andpay:internal-admin`
// token is rejected at vendor-auth-edge's session surface / vendor-edge, the
// ONLY possible reason is the audience (or the cls defense-in-depth guard):
// the key that signed it is right there in the verifying edge's JWKS, and the
// issuer matches. A stray key/issuer mismatch is structurally ruled out.
// -----------------------------------------------------------------------------

const SHARED_ISS = 'https://auth.andpay.test/cross-edge-isolation-test'

const authUrl = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'

const authDb: AuthDb = new AuthClient({ datasourceUrl: authUrl })
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({
  datasourceUrl: process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

let sharedSigner: KmsSigningPort
let sharedJwks: JSONWebKeySet

let authEdgeApp: INestApplication
let opsEdgeApp: INestApplication
let tenantEdgeApp: INestApplication
let vendorAuthEdgeApp: INestApplication
let vendorIntakeEdgeApp: INestApplication

// A real cls:7 aud:andpay:vendor token, signed by the shared multi-key
// signer's VENDOR_PLANE adapter (a key published in every edge's jwks below).
async function issueVendorToken(vndrWire: string): Promise<string> {
  return issueAccessToken(
    { principalId: `vop_${randomUUID().slice(0, 8)}`, cls: 7, mode: 'live', scope: { vndr: vndrWire }, psr: 'vset:vendor_operator', epoch: 1, aud: VENDOR_PLANE },
    { signer: sharedSigner, iss: SHARED_ISS, ttlSec: 300 },
  )
}

// A real cls:3 aud:andpay:internal-admin token, signed by the shared
// multi-key signer's INTERNAL_ADMIN_PLANE adapter (a key published in every
// edge's jwks below).
async function issueInternalAdminToken(): Promise<string> {
  return issueAccessToken(
    { principalId: randomUUID(), cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, aud: INTERNAL_ADMIN_PLANE },
    { signer: sharedSigner, iss: SHARED_ISS, ttlSec: 300 },
  )
}

function intakeSheet(vndrWire: string, deviceSerial: string, workQueue = 'wq-any'): Record<string, unknown> {
  return {
    fileId: `file-audience-isolation-${deviceSerial}`,
    vndrId: vndrWire,
    workQueue,
    rows: [{ kind: 'SERIALIZED', deviceSerial, productType: 'SOUNDBOX', deviceQr: { di: `DI-${deviceSerial}` } }],
  }
}

async function postIntake(sheet: Record<string, unknown>, authHeader: string) {
  return request(vendorIntakeEdgeApp.getHttpServer())
    .post('/vendor/intake')
    .set('Authorization', authHeader)
    .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
}

interface AuditOutboxRow {
  decision: string
  operation: string
  reasonCode: string | undefined
}

async function fulfillmentAuditRows(): Promise<AuditOutboxRow[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: { decision: string; operation: string; reasonCode?: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation, reasonCode: r.payload.reasonCode }))
}

async function unitCount(): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  const internalAdapter = await LocalEs256Adapter.create('cross-edge-internal-1')
  const vendorAdapter = await LocalEs256Adapter.create('cross-edge-vendor-1')
  sharedSigner = LocalEs256Adapter.createMulti({
    [INTERNAL_ADMIN_PLANE]: internalAdapter,
    [VENDOR_PLANE]: vendorAdapter,
  })
  sharedJwks = await sharedSigner.jwks()

  const vault = new Map<string, string>()
  const storeSecret = async (principalId: string, secret: string, principalType = 'internal'): Promise<string> => {
    // One custody key per ENROLLMENT, not per principal: a shared key let a new
    // secret destroy the previous one.
    const ref = `vault://${principalType}/${principalId}/${randomUUID()}`
    vault.set(ref, secret)
    return ref
  }
  const resolveSecretRef = async (secretRef: string): Promise<string | undefined> => vault.get(secretRef)

  const authEdgeDeps: AuthEdgeDeps = {
    authDb,
    signer: sharedSigner,
    jwks: sharedJwks,
    mfa: new TotpAdapter(),
    resolveSecretRef,
    storeSecret,
    expectedIss: SHARED_ISS,
    expectedMode: 'live',
    roleConfig: loadConfig(),
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    totpIssuer: 'AndPayments Cross-Edge Test',
    portalOrigin: 'https://login.andpay.test',
    throttle: AuthNoThrottle,
  }
  authEdgeApp = await buildAuthEdgeApp(authEdgeDeps)
  await authEdgeApp.init()

  const opsEdgeDeps: OpsEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
    identityDb,
    jwks: sharedJwks,
    expectedIss: SHARED_ISS,
    expectedMode: 'live',
    roleConfig: loadOpsConfig(),
    portalOrigin: 'https://ops.andpay.test',
    assetStore: new InMemoryAssetStore(),
  }
  opsEdgeApp = await buildOpsEdgeApp(opsEdgeDeps)
  await opsEdgeApp.init()

  const tenantEdgeDeps: TenantEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
    jwks: sharedJwks,
    expectedIss: SHARED_ISS,
    expectedMode: 'live',
    portalOrigin: 'https://tenant.andpay.test',
  }
  tenantEdgeApp = await buildTenantEdgeApp(tenantEdgeDeps)
  await tenantEdgeApp.init()

  const vendorAuthEdgeDeps: VendorAuthEdgeDeps = {
    authDb,
    signer: sharedSigner,
    jwks: sharedJwks,
    mfa: new TotpAdapter(),
    resolveSecretRef,
    storeSecret: async (principalId: string, secret: string, principalType?: string) => storeSecret(principalId, secret, principalType),
    expectedIss: SHARED_ISS,
    expectedMode: 'live',
    roleConfig: loadConfig(),
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    totpIssuer: 'AndPayments Cross-Edge Vendor Test',
    vendorPortalOrigin: 'https://vendor.andpay.test',
    throttle: VendorAuthNoThrottle,
  }
  vendorAuthEdgeApp = await buildVendorAuthEdgeApp(vendorAuthEdgeDeps)
  await vendorAuthEdgeApp.init()

  const vendorIntakeEdgeDeps: VendorIntakeEdgeDeps = {
    fulfillmentDb,
    pepper: 'dev-pepper-not-a-real-secret',
    expectedMode: 'live',
    jwks: sharedJwks,
    expectedIss: SHARED_ISS,
    vendorPortalOrigin: 'https://vendor.andpay.test',
    assetStore: new InMemoryAssetStore(),
  }
  vendorIntakeEdgeApp = await buildVendorIntakeEdgeApp(vendorIntakeEdgeDeps)
  await vendorIntakeEdgeApp.init()
})

afterAll(async () => {
  // F-4: the DO-NOT-by-design case below really does provision an operator
  // (it asserts a 200), through the ROUTE, so nothing else knows the row
  // exists. `auth` is the one schema the global teardown refuses to touch, so
  // without this the row outlives every gate. Scoped to this suite's own
  // prefix; authz_audit is hash-chained and is not touched.
  try {
    const created = await authDb.vendorOperator.findMany({
      where: { username: { startsWith: 'cross-edge-op-' } },
      select: { id: true },
    })
    const ids = created.map((r) => r.id)
    if (ids.length > 0) {
      await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: ids } } })
      await authDb.refreshToken.deleteMany({ where: { principalId: { in: ids } } })
      await authDb.vendorOperator.deleteMany({ where: { id: { in: ids } } })
    }
  } catch (e) {
    console.warn('[cross-edge cleanup] failed to remove provisioned operators:', e)
  }
  await authEdgeApp.close()
  await opsEdgeApp.close()
  await tenantEdgeApp.close()
  await vendorAuthEdgeApp.close()
  await vendorIntakeEdgeApp.close()
  await authDb.$disconnect()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
})

beforeEach(async () => {
  // Shared truncate: ops-edge, tenant-edge, and vendor-edge all commit their
  // authn-DENY authz-audit fact into the SAME fulfillment outbox table, and
  // vendor-edge's own scope pair test writes real vndr/unit rows. Cleared
  // before every test so each assertion below reads exactly its own request's
  // effect.
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, intake_exception, pending_pool_entry, vndr, credential_projection, outbox, inbox CASCADE',
  )
})

describe('check 8, item 1: a class-7 aud:andpay:vendor token is rejected at auth-edge (wrong audience)', () => {
  it('a real cls:7 aud:andpay:vendor token, signed by a key IN auth-edge\'s own jwks, is rejected at /session/stepup', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await issueVendorToken(vndrWire)

    const res = await request(authEdgeApp.getHttpServer())
      .post('/session/stepup')
      .set('Authorization', `Bearer ${token}`)
      .send({ totp: '000000' })

    expect(res.status).toBe(401)
  })
})

describe('check 8, item 2: a class-7 aud:andpay:vendor token is rejected at the class-3/class-2 human edges', () => {
  it('is rejected at ops-edge (expectedPlane andpay:internal-admin != andpay:vendor)', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await issueVendorToken(vndrWire)

    const res = await request(opsEdgeApp.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await fulfillmentAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })

  it('is rejected at tenant-edge (expectedPlane andpay:tenant-portal != andpay:vendor)', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await issueVendorToken(vndrWire)

    const res = await request(tenantEdgeApp.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await fulfillmentAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })
})

describe('check 8, item 3: an internal-admin token is rejected at the vendor-auth-edge VENDOR-SESSION surface', () => {
  it('a real cls:3 aud:andpay:internal-admin token is rejected at POST /password/change (expectedAud pinned to andpay:vendor)', async () => {
    const token = await issueInternalAdminToken()

    const res = await request(vendorAuthEdgeApp.getHttpServer())
      .post('/password/change')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'irrelevant', newPassword: 'irrelevant-too' })

    expect(res.status).toBe(401)
  })

  it('DO-NOT (by design, not a violation): the SAME internal-admin token is ACCEPTED at the admin-guarded POST /provision', async () => {
    const token = await issueInternalAdminToken()
    const username = `cross-edge-op-${randomUUID().slice(0, 8)}`

    const res = await request(vendorAuthEdgeApp.getHttpServer())
      .post('/provision')
      .set('Authorization', `Bearer ${token}`)
      .send({ vndrId: fromUuid('vndr', toUuid(newId('vndr'))), username, password: 'correct horse battery staple' })

    // This is the DELIBERATE admin-authority path (spec 14a task 11, check 3):
    // the class-3 internal-admin plane administers vendor_operator provisioning.
    // It is NOT the boundary this suite proves; the boundary is item 3 above
    // (the vendor SESSION surface), which correctly rejects this same token.
    expect(res.status).toBe(200)
    expect(res.body.otpauthUri).toBeDefined()
  })
})

describe('check 8, item 4: an internal-admin token is rejected at the vendor-edge (fulfillment intake)', () => {
  it('a real cls:3 aud:andpay:internal-admin token, signed by a key IN vendor-edge\'s own jwks, is rejected at POST /vendor/intake', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await issueInternalAdminToken()

    const res = await postIntake(intakeSheet(vndrWire, 'SER-AUD-ISO-INTERNAL-1'), `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(await unitCount()).toBe(0)

    const rows = await fulfillmentAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })
})

describe('check 8, item 5: the vendor-edge accepts the class-7 token and authorizes ONLY within scope.vndr', () => {
  it('an in-scope cls:7 aud:andpay:vendor token submits intake for its OWN vndr (200)', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await issueVendorToken(vndrWire)

    const res = await postIntake(intakeSheet(vndrWire, 'SER-AUD-ISO-INSCOPE-1'), `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.createdUnitIds).toHaveLength(1)
    expect(await unitCount()).toBe(1)
  })

  it('a cls:7 token bound to vndr A submitting a sheet claiming vndr B is rejected 403 scope-denied', async () => {
    const vndrAWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrBWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await issueVendorToken(vndrAWire)

    const res = await postIntake(intakeSheet(vndrBWire, 'SER-AUD-ISO-CROSS-1'), `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(await unitCount()).toBe(0)

    const rows = await fulfillmentAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('scope-denied')
  })
})
