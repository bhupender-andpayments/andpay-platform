import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID, createHmac } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { buildEdgeApp, type EdgeDeps } from '../src/index.js'

// Spec 14a task 13: the vendor edge verifies a class-7 vendor-operator JWT
// LOCALLY (T4/S14/5e, zero call to Auth), routed to authorizeVendor with the
// work-queue axis SKIPPED (Fork C, evaluate.ts), while the class-6 apsk_
// bearer path stays byte-unchanged (D6). This suite exercises the guard's
// credential-format dispatch (bearer apsk_ -> local resolve, JWT -> JWKS
// verify) plus the class-7 vendor-operator vendorSet added to
// loadFulfillmentConfig.
const EXPECTED_ISS = 'https://auth.andpay.test/vendor'
const KID = 'vendor-edge-test-key-1'
const PEPPER = 'dev-pepper-not-a-real-secret'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

let app: INestApplication
let jwks: JSONWebKeySet
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

async function mint(claim: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'vop_1',
    cls: 7,
    mode: 'test',
    aud: 'andpay:vendor',
    scope: {},
    psr: 'vset:vendor_operator',
    epoch: 1,
    jti: randomUUID(),
    ...claim,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KID })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .setIssuer(EXPECTED_ISS)
    .sign(privateKey)
}

interface AuditOutboxRow {
  decision: string
  operation: string
  reasonCode: string | undefined
}

async function auditRows(): Promise<AuditOutboxRow[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: { decision: string; operation: string; reasonCode?: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation, reasonCode: r.payload.reasonCode }))
}

async function seedCredential(opts: {
  apiId: string
  secret: string
  vndrId: string
  workQueue: string
  permissionSetRef: string
}): Promise<void> {
  const pepperedHash = createHmac('sha256', PEPPER).update(opts.secret).digest('hex')
  await fulfillmentDb.$executeRaw`
    INSERT INTO credential_projection (api_id, peppered_hash, vndr_id, work_queue, permission_set_ref, mode, status, epoch, updated_at)
    VALUES (${toUuid(opts.apiId)}::uuid, ${pepperedHash}, ${toUuid(opts.vndrId)}::uuid, ${opts.workQueue}, ${opts.permissionSetRef}, 'test', 'ACTIVE', 1, now())
  `
}

function intakeSheet(vndrWire: string, deviceSerial: string, workQueue = 'wq-any'): Record<string, unknown> {
  return {
    fileId: `file-class7-${deviceSerial}`,
    vndrId: vndrWire,
    workQueue,
    rows: [{ kind: 'SERIALIZED', deviceSerial, productType: 'SOUNDBOX', deviceQr: { di: `DI-${deviceSerial}` } }],
  }
}

async function postIntake(sheet: Record<string, unknown>, authHeader: string) {
  return request(app.getHttpServer())
    .post('/vendor/intake')
    .set('Authorization', authHeader)
    .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
}

async function unitCount(): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM unit`
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  jwks = { keys: [jwk] }

  const deps: EdgeDeps = {
    fulfillmentDb,
    pepper: PEPPER,
    expectedMode: 'test',
    jwks,
    expectedIss: EXPECTED_ISS,
    vendorPortalOrigin: 'https://vendor.andpay.test',
  }
  app = await buildEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, intake_exception, pending_pool_entry, vndr, credential_projection, outbox, inbox CASCADE',
  )
})

describe('class-7 vendor-operator JWT: in-scope authorizes, work-queue is NOT enforced', () => {
  it('a valid cls:7 aud:andpay:vendor JWT bound to scope.vndr submits intake for that same vndr (wq skipped)', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ scope: { vndr: vndrWire } })

    const res = await postIntake(intakeSheet(vndrWire, 'SER-C7-1', 'some-other-wq'), `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.createdUnitIds).toHaveLength(1)
    expect(await unitCount()).toBe(1)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('sheet:submit-intake')
  })
})

describe('class-7 vendor-operator JWT: cross-vndr is rejected (scope-denied)', () => {
  it('a cls:7 JWT bound to vndr A submitting a sheet claiming vndr B -> 403 scope-denied, no Unit created', async () => {
    const vndrAWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrBWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ scope: { vndr: vndrAWire } })

    const res = await postIntake(intakeSheet(vndrBWire, 'SER-C7-CROSS-1'), `Bearer ${token}`)
    expect(res.status).toBe(403)
    expect(await unitCount()).toBe(0)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('scope-denied')
  })
})

describe('a JWT asserting cls:6 is rejected regardless of a valid signature (105f/5f)', () => {
  it('a validly-signed andpay:vendor JWT with cls:6 -> 401 class6-jwt-rejected', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ cls: 6, scope: { vndr: vndrWire, wq: 'wq-any' } })

    const res = await postIntake(intakeSheet(vndrWire, 'SER-C7-CLS6-1'), `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('class6-jwt-rejected')
    expect(await unitCount()).toBe(0)
  })
})

describe('an internal-admin-plane JWT is rejected at the vendor edge (wrong audience)', () => {
  it('a validly-signed cls:7-shaped JWT with aud:andpay:internal-admin -> 401 (the verifier pins aud to andpay:vendor)', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ aud: 'andpay:internal-admin', scope: { vndr: vndrWire } })

    const res = await postIntake(intakeSheet(vndrWire, 'SER-C7-WRONGAUD-1'), `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
    expect(await unitCount()).toBe(0)
  })
})

describe('DO-NOT: the class-6 apsk_ bearer path resolves and authorizes exactly as before (D6)', () => {
  it('an apsk_ bearer still resolves to cls:6 and submits intake, unaffected by the jwks/expectedIss wiring added for class 7', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_class7-task-manufacturer-secret-zzzz'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrWire,
      workQueue: 'wq-manufacturer',
      permissionSetRef: 'vset:vendor_manufacturer',
    })

    const res = await postIntake(intakeSheet(vndrWire, 'SER-C7-APSK-1', 'wq-manufacturer'), `Bearer ${secret}`)
    expect(res.status).toBe(200)
    expect(res.body.createdUnitIds).toHaveLength(1)
    expect(await unitCount()).toBe(1)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('sheet:submit-intake')
  })

  it('an apsk_ bearer whose sheet claims a DIFFERENT vndr is still rejected scope-denied (the class-6 work-queue+vndr axes stay enforced)', async () => {
    const vndrAWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrBWire = fromUuid('vndr', toUuid(newId('vndr')))
    const secret = 'apsk_test_class7-task-manufacturer-cross-yyyy'
    await seedCredential({
      apiId: newId('api'),
      secret,
      vndrId: vndrAWire,
      workQueue: 'wq-manufacturer',
      permissionSetRef: 'vset:vendor_manufacturer',
    })

    const res = await postIntake(intakeSheet(vndrBWire, 'SER-C7-APSK-CROSS-1', 'wq-manufacturer'), `Bearer ${secret}`)
    expect(res.status).toBe(403)
    expect(await unitCount()).toBe(0)
  })
})
