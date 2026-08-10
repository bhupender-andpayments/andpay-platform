import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient } from '@andpay/identity-service'
import { newId, toUuid } from '@andpay/ids'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// P2-1: the four object-spine READ routes over the real app. The point of
// interest is the READ posture, not a write: these are guard-only, so an
// authenticated class-3 operator gets 200 with NO 6e audit emitted at all
// (reads are not mutations, check 3). Also pins the route shapes, because
// `/ops/batches/:btchId` sits next to the pre-existing
// `/ops/batches/:btchId/excel/:group` and a careless param route would
// swallow it.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-object-spine-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({
  datasourceUrl:
    process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

const TENANT = toUuid(newId('tnnt'))
const PROGRAM = toUuid(newId('prog'))
const SECRET_MOBILE = '9537908017'
const SECRET_ADDRESS = 'PLOT 42 SECRET LANE'

// A baseline ops operator, deliberately NOT admin: these reads are guard-only,
// so the lowest class-3 role must still see them.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_1',
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'role:ops',
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

async function seedBatchWithEntry(): Promise<{ btchWire: string; asgnWire: string }> {
  const btchWire = newId('btch')
  const btchUuid = toUuid(btchWire)
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  await fulfillmentDb.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, trigger_reason, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${TENANT}::uuid, ${PROGRAM}::uuid, NULL, 'LOT_SIZE', 1, now())
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      branch_code, ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value,
      pool_status, batch, source_event_id, trace_id, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${TENANT}::uuid, ${PROGRAM}::uuid, true, 1, 2, true,
      'BRILLIANT PERFUME', 'BRILLIANT PERFUME', '5977', '1568', 'GSC BANK',
      '30', ${SECRET_ADDRESS}, 'SECRET CONTACT', ${SECRET_MOBILE},
      'upi://pay?ver=01&mode=01&pa=x@gscb', 'x@gscb',
      'BATCHED', ${btchUuid}::uuid, ${`evt-${randomUUID()}`}, ${`trace-${randomUUID()}`}, now()
    )
  `
  return { btchWire, asgnWire }
}

async function seedShipment(): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${toUuid(newId('shpt'))}::uuid, ${`AWB-${randomUUID()}`}, NULL, 'IN_TRANSIT', now(),
            ${TENANT}::uuid, ${PROGRAM}::uuid, now())
  `
}

async function auditCount(): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM outbox WHERE event_type = 'authz.audit'
  `
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
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
  await identityDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE composed_artifact, pending_pool_entry, batch, shpt, outbox, inbox CASCADE',
  )
})

describe('P2-1 object-spine routes: authentication', () => {
  it('all four require a token', async () => {
    for (const path of ['/ops/batches', '/ops/pool', '/ops/dispatches', `/ops/batches/${newId('btch')}`]) {
      const res = await request(app.getHttpServer()).get(path)
      expect(res.status, `${path} must be 401 without a token`).toBe(401)
    }
  })

  it('the step-7 merchants route requires a token too', async () => {
    const res = await request(app.getHttpServer()).get('/ops/merchants')
    expect(res.status).toBe(401)
  })
})

// Redesign step 7 (ruling 1b). The fifth object-spine read, and the only one
// served from the TMS db rather than fulfillment. Seeds and removes its own
// rows by id: merchant_projection is NOT in the fulfillment beforeEach truncate
// above, and truncating a projection other TMS suites write to would be a
// cross-suite data dependency of exactly the kind already filed as F-1.
describe('step-7 merchants route', () => {
  async function seedMerchant(displayName: string, status = 'ACTIVE'): Promise<{ wire: string; uuid: string }> {
    const wire = newId('mrch')
    const uuid = toUuid(wire)
    await tmsDb.$executeRaw`
      INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
      VALUES (${uuid}::uuid, ${displayName}, ${'LEGAL ' + displayName}, ${'5411'}, ${status}, now())
    `
    return { wire, uuid }
  }

  async function removeMerchant(uuid: string): Promise<void> {
    await tmsDb.$executeRaw`DELETE FROM merchant_projection WHERE id = ${uuid}::uuid`
  }

  it('GET /ops/merchants -> 200 with the merchant, as a WIRE id', async () => {
    const m = await seedMerchant('ZZ EDGE PROBE')
    try {
      const res = await request(app.getHttpServer())
        .get('/ops/merchants')
        .set('Authorization', `Bearer ${await mint()}`)
      expect(res.status).toBe(200)
      const row = res.body.find((r: { mrchId: string }) => r.mrchId === m.wire)
      expect(row, 'the seeded merchant must cross the wire').toBeDefined()
      expect(row.displayName).toBe('ZZ EDGE PROBE')
      // The raw uuid must not appear ANYWHERE in the response body.
      expect(JSON.stringify(res.body)).not.toContain(m.uuid)
    } finally {
      await removeMerchant(m.uuid)
    }
  })

  it('emits NO 6e audit: a read is not a mutation (check 3)', async () => {
    const m = await seedMerchant('ZZ EDGE AUDIT PROBE')
    try {
      await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox')
      await request(app.getHttpServer()).get('/ops/merchants').set('Authorization', `Bearer ${await mint()}`)
      const rows = await fulfillmentDb.$queryRawUnsafe<unknown[]>('SELECT id FROM outbox')
      expect(rows.length, 'a guard-only read must emit nothing').toBe(0)
    } finally {
      await removeMerchant(m.uuid)
    }
  })
})

describe('P2-1 object-spine routes: a baseline ops operator can read all four', () => {
  it('GET /ops/batches -> 200 with the batch', async () => {
    const { btchWire } = await seedBatchWithEntry()
    const res = await request(app.getHttpServer()).get('/ops/batches').set('Authorization', `Bearer ${await mint()}`)
    expect(res.status).toBe(200)
    expect(res.body.map((b: { id: string }) => b.id)).toEqual([btchWire])
  })

  it('GET /ops/pool -> 200, and ?poolStatus narrows', async () => {
    const { asgnWire } = await seedBatchWithEntry()
    const token = await mint()
    const all = await request(app.getHttpServer()).get('/ops/pool').set('Authorization', `Bearer ${token}`)
    expect(all.status).toBe(200)
    expect(all.body.map((p: { asgnId: string }) => p.asgnId)).toEqual([asgnWire])

    const pooled = await request(app.getHttpServer())
      .get('/ops/pool?poolStatus=POOLED')
      .set('Authorization', `Bearer ${token}`)
    expect(pooled.status).toBe(200)
    expect(pooled.body).toEqual([])
  })

  it('GET /ops/dispatches -> 200 with the shipment', async () => {
    await seedShipment()
    const res = await request(app.getHttpServer()).get('/ops/dispatches').set('Authorization', `Bearer ${await mint()}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].awb.startsWith('AWB-')).toBe(true)
  })

  it('GET /ops/batches/:btchId -> 200 with header, entries and artifacts', async () => {
    const { btchWire, asgnWire } = await seedBatchWithEntry()
    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${btchWire}`)
      .set('Authorization', `Bearer ${await mint()}`)
    expect(res.status).toBe(200)
    expect(res.body.batch.id).toBe(btchWire)
    expect(res.body.entries.map((e: { asgnId: string }) => e.asgnId)).toEqual([asgnWire])
    expect(res.body.artifacts).toEqual([])
  })

  it('GET /ops/batches/:btchId -> 404 for an unknown batch', async () => {
    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${newId('btch')}`)
      .set('Authorization', `Bearer ${await mint()}`)
    expect(res.status).toBe(404)
  })

  it('GET /ops/batches/:btchId -> 400, NOT 500, for a MALFORMED id', async () => {
    // Regression: the first version of this route returned 500 for a bad id,
    // because toUuid throws InvalidIdError and the ops error filter had no
    // mapping for it. Every typed-id route was affected, not just this one.
    // The 404 test above passes a WELL-FORMED id, which is why it did not
    // catch this; only probing the running edge did.
    const token = await mint()
    for (const bad of ['not-an-id', 'btch_short', 'btch_' + '!'.repeat(26)]) {
      const res = await request(app.getHttpServer())
        .get(`/ops/batches/${encodeURIComponent(bad)}`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status, `${bad} must be a 4xx client error`).toBe(400)
      expect(res.body.code).toBe('invalid-id')
      // The thrown message echoes caller input; it must not ride the response.
      expect(JSON.stringify(res.body)).not.toContain('payload')
    }
  })
})

describe('P2-1 object-spine routes: posture', () => {
  it('emits NO 6e audit: reads are not mutations (check 3)', async () => {
    await seedBatchWithEntry()
    await seedShipment()
    const token = await mint()
    for (const path of ['/ops/batches', '/ops/pool', '/ops/dispatches']) {
      await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)
    }
    expect(await auditCount()).toBe(0)
  })

  it('the detail route does not swallow the pre-existing excel/:group download', async () => {
    // `/ops/batches/:btchId` and `/ops/batches/:btchId/excel/:group` are
    // distinct routes; a regression that collapsed them would return JSON here.
    const { btchWire } = await seedBatchWithEntry()
    const res = await request(app.getHttpServer())
      .get(`/ops/batches/${btchWire}/excel/SOUNDBOX`)
      .set('Authorization', `Bearer ${await mint()}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml')
  })

  it('no recipient PII crosses the wire on the list routes (D104)', async () => {
    await seedBatchWithEntry()
    const token = await mint()
    for (const path of ['/ops/pool', '/ops/batches']) {
      const res = await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`)
      const body = JSON.stringify(res.body)
      expect(body, `${path} leaked an address`).not.toContain(SECRET_ADDRESS)
      expect(body, `${path} leaked a mobile`).not.toContain(SECRET_MOBILE)
      expect(body, `${path} leaked a raw upi payload`).not.toContain('upi://')
    }
  })
})
