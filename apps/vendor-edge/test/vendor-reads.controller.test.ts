import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { buildEdgeApp, type EdgeDeps } from '../src/index.js'

// Spec 14b task 6: the class-7 vendor-operator GET reads (work-queue,
// history), gated on batch:read. Mirrors class7-verify.test.ts's token
// minting (real ES256-signed class-7 JWTs, local JWKS verify, zero call to
// Auth) and http-roundtrip.test.ts's audit-outbox read helper.
const EXPECTED_ISS = 'https://auth.andpay.test/vendor'
const KID = 'vendor-edge-reads-test-key-1'
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

// Seeds one BORN batch owned by `vndrWire` with one still-open
// pending_pool_entry (dispatch_state NULL), so readVendorWorkQueue surfaces
// exactly this batch for that vndr's own scope.
async function seedOpenBatch(vndrWire: string): Promise<{ btchWire: string }> {
  const vndrUuid = toUuid(vndrWire)
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))
  const btchUuid = toUuid(newId('btch'))

  await fulfillmentDb.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${vndrUuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id, updated_at
    ) VALUES (
      ${toUuid(newId('asgn'))}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      '1 Main St', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${btchUuid}::uuid, NULL, 'evt-reads-1', 'trace-reads-1', now()
    )
  `
  return { btchWire: fromUuid('btch', btchUuid) }
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
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, intake_exception, pending_pool_entry, batch, vndr, credential_projection, outbox, inbox CASCADE',
  )
})

describe('GET /vendor/work-queue (class-7, batch:read)', () => {
  it('a class-7 claim WITH batch:read (vset:vendor_operator) gets its own-vndr work-queue rows, no ALLOW audit emitted', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire } = await seedOpenBatch(vndrWire)
    const token = await mint({ scope: { vndr: vndrWire } })

    const res = await request(app.getHttpServer()).get('/vendor/work-queue').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].btchId).toBe(btchWire)

    // reads emit NO allow audit (spec-13 ops-read precedent): the outbox
    // stays empty on the happy path.
    expect(await auditRows()).toHaveLength(0)
  })

  it('a claim WITHOUT batch:read (vset:vendor_courier) is rejected 403 with a standalone permission-denied DENY audit', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    await seedOpenBatch(vndrWire)
    const token = await mint({ scope: { vndr: vndrWire }, psr: 'vset:vendor_courier' })

    const res = await request(app.getHttpServer()).get('/vendor/work-queue').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('batch:read')
    expect(rows[0]!.reasonCode).toBe('permission-denied')
  })

  it('a query-string vndr is never honored: rows always come from the token scope, not the request', async () => {
    const ownVndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const otherVndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire: ownBtchWire } = await seedOpenBatch(ownVndrWire)
    await seedOpenBatch(otherVndrWire)
    const token = await mint({ scope: { vndr: ownVndrWire } })

    const res = await request(app.getHttpServer())
      .get('/vendor/work-queue')
      .query({ vndr: otherVndrWire })
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].btchId).toBe(ownBtchWire)
  })
})

describe('GET /vendor/history (class-7, batch:read)', () => {
  it('a class-7 claim WITH batch:read gets its own-vndr dispatch history, no ALLOW audit emitted', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrUuid = toUuid(vndrWire)
    const tnnt = toUuid(newId('tnnt'))
    const prog = toUuid(newId('prog'))
    const btchUuid = toUuid(newId('btch'))
    const shptUuid = toUuid(newId('shpt'))

    await fulfillmentDb.$executeRaw`
      INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
      VALUES (${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${vndrUuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
    `
    await fulfillmentDb.$executeRaw`
      INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
      VALUES (${shptUuid}::uuid, 'AWB-READS-1', 'DISPATCHED_BY_VENDOR', now(), ${tnnt}::uuid, ${prog}::uuid, now())
    `
    await fulfillmentDb.$executeRaw`
      INSERT INTO unit (id, kind, product_type, manufacturer_vndr, batch, status, device_serial, shipment, updated_at)
      VALUES (${toUuid(newId('unit'))}::uuid, 'SERIALIZED', 'SOUNDBOX', ${vndrUuid}::uuid, ${btchUuid}::uuid, 'DISPATCHED', 'SN-READS-1', ${shptUuid}::uuid, now())
    `
    const token = await mint({ scope: { vndr: vndrWire } })

    const res = await request(app.getHttpServer()).get('/vendor/history').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].awb).toBe('AWB-READS-1')
    expect(await auditRows()).toHaveLength(0)
  })

  it('a claim WITHOUT batch:read is rejected 403 with a standalone permission-denied DENY audit', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ scope: { vndr: vndrWire }, psr: 'vset:vendor_manufacturer' })

    const res = await request(app.getHttpServer()).get('/vendor/history').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('batch:read')
    expect(rows[0]!.reasonCode).toBe('permission-denied')
  })
})
