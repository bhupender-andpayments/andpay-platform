import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { buildEdgeApp, type EdgeDeps } from '../src/index.js'

// Spec 14b check 3-write / check 4-functional: class7-verify.test.ts proves
// the class-7 vendor-operator JWT mechanism ONLY on /vendor/intake. The
// return route (/vendor/return) runs its own authorizeAndAudit call with
// operation 'sheet:submit-return' inside return.controller.ts, so nothing
// today proves a class-7 JWT reaches ingestReturnSheet, that a cross-vndr
// forged sheet.vndrId is rejected AT THE EDGE (no write), or that a cls:6
// JWT is rejected on this route. This suite closes that gap, over real HTTP,
// with a real signed ES256 andpay:vendor JWT (mint() mirrors
// class7-verify.test.ts exactly), and the return-route seeding (seedUnit +
// seedPendingEntry + multipart file POST) mirrors http-roundtrip.test.ts.
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

// -------- return-sheet domain fixtures (mirrors http-roundtrip.test.ts) --------

async function seedUnit(deviceSerial: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, device_qr, updated_at)
    VALUES (${toUuid(newId('unit'))}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(newId('vndr'))}::uuid, 'IN_STOCK', ${deviceSerial}, '{}'::jsonb, now())
  `
}

async function seedPendingEntry(asgnWire: string): Promise<void> {
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, merchant_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, batch, dispatch_state, source_event_id, trace_id,
      created_at, updated_at
    ) VALUES (
      ${toUuid(asgnWire)}::uuid, ${toUuid(newId('tnnt'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('mrch'))}::uuid,
      true, 1, 0, true, 'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'BATCHED', ${toUuid(newId('btch'))}::uuid, 'SENT_TO_VENDOR',
      'file-class7-return|1', 'trace-class7-return-snapshot', now(), now()
    )
  `
}

async function unitPairing(deviceSerial: string): Promise<{ batch: string | null; shipment: string | null }> {
  const rows = await fulfillmentDb.$queryRaw<{ batch: string | null; shipment: string | null }[]>`
    SELECT batch::text AS batch, shipment::text AS shipment FROM unit WHERE device_serial = ${deviceSerial}
  `
  return rows[0]!
}

async function shptCountForAwb(awb: string): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shpt WHERE awb = ${awb}`
  return Number(rows[0]!.n)
}

function returnSheet(vndrWire: string, deviceSerial: string, asgnWire: string, awb: string, workQueue = 'wq-print'): Record<string, unknown> {
  return {
    fileId: `file-class7-return-${deviceSerial}`,
    vndrId: vndrWire,
    workQueue,
    rows: [{ deviceSerial, asgnId: asgnWire, awb }],
  }
}

async function postReturn(sheet: Record<string, unknown>, authHeader: string) {
  return request(app.getHttpServer())
    .post('/vendor/return')
    .set('Authorization', authHeader)
    .attach('file', Buffer.from(JSON.stringify(sheet), 'utf8'), 'sheet.json')
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

describe('class-7 vendor-operator JWT on /vendor/return: in-scope reaches ingestReturnSheet and pairs the Unit', () => {
  it('a valid cls:7 aud:andpay:vendor JWT bound to scope.vndr submits a return for that same vndr and actually pairs the unit', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ scope: { vndr: vndrWire } })

    const deviceSerial = 'SER-C7-RETURN-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)
    const awb = 'AWB-C7-RETURN-1'

    const res = await postReturn(returnSheet(vndrWire, deviceSerial, asgnWire, awb), `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.pairedUnitIds).toHaveLength(1)
    expect(res.body.shptIds).toHaveLength(1)

    const pairing = await unitPairing(deviceSerial)
    expect(pairing.shipment).not.toBeNull()
    expect(pairing.batch).not.toBeNull()
    expect(await shptCountForAwb(awb)).toBe(1)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('sheet:submit-return')
  })
})

describe('class-7 vendor-operator JWT on /vendor/return: cross-vndr forged vndrId is rejected AT THE EDGE (write isolation)', () => {
  it('a cls:7 JWT bound to vndr A submitting a return sheet claiming vndr B -> 403 scope-denied, Unit stays unpaired, no shpt row born', async () => {
    const vndrAWire = fromUuid('vndr', toUuid(newId('vndr')))
    const vndrBWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ scope: { vndr: vndrAWire } })

    const deviceSerial = 'SER-C7-RETURN-CROSS-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)
    const awb = 'AWB-C7-RETURN-CROSS-1'

    // the JWT is real and validly bound to vndr A, but the sheet CLAIMS to be
    // FOR vndr B: this is exactly the forged/cross-vndr write a vendor
    // operator must never be able to perform onto another vendor's dispatch.
    const res = await postReturn(returnSheet(vndrBWire, deviceSerial, asgnWire, awb), `Bearer ${token}`)
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('sheet:submit-return')
    expect(rows[0]!.reasonCode).toBe('scope-denied')

    // ingestReturnSheet was never reached: no write happened at all.
    const pairing = await unitPairing(deviceSerial)
    expect(pairing.shipment).toBeNull()
    expect(pairing.batch).toBeNull()
    expect(await shptCountForAwb(awb)).toBe(0)
  })
})

describe('a JWT asserting cls:6 is rejected on /vendor/return regardless of a valid signature (105f/5f)', () => {
  it('a validly-signed andpay:vendor JWT with cls:6 -> 401 class6-jwt-rejected, no write', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const token = await mint({ cls: 6, scope: { vndr: vndrWire, wq: 'wq-print' } })

    const deviceSerial = 'SER-C7-RETURN-CLS6-1'
    await seedUnit(deviceSerial)
    const asgnWire = newId('asgn')
    await seedPendingEntry(asgnWire)
    const awb = 'AWB-C7-RETURN-CLS6-1'

    const res = await postReturn(returnSheet(vndrWire, deviceSerial, asgnWire, awb), `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('class6-jwt-rejected')

    const pairing = await unitPairing(deviceSerial)
    expect(pairing.shipment).toBeNull()
    expect(await shptCountForAwb(awb)).toBe(0)
  })
})
