import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient as FulfillmentClient, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { buildEdgeApp, type EdgeDeps } from '../src/index.js'

// Spec 14b task 7: the FR-04 dispatch-package pull route. Mirrors
// vendor-reads.controller.test.ts's class-7 token minting (real ES256-signed
// JWTs, local JWKS verify) and vendor-pull.test.ts's seed shape (services/
// fulfillment/test/vendor-pull.test.ts), driven this time over real HTTP.
const EXPECTED_ISS = 'https://auth.andpay.test/vendor'
const KID = 'vendor-edge-pull-test-key-1'
const PEPPER = 'dev-pepper-not-a-real-secret'
const SHIP_TO_ADDRESS = '221B Baker Street, Marylebone'

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

// Seeds one BORN batch owned by `vndrWire` with one pending_pool_entry
// (carrying recipient PII) and one composed_artifact row, exactly the shape
// vendor-pull.test.ts's own seed() uses.
async function seedBatch(vndrWire: string): Promise<{ btchWire: string }> {
  const vndrUuid = toUuid(vndrWire)
  const tnnt = toUuid(newId('tnnt'))
  const prog = toUuid(newId('prog'))
  const btchUuid = toUuid(newId('btch'))

  await fulfillmentDb.$executeRaw`
    INSERT INTO batch (id, tenant_id, program_id, print_vndr, status, trigger_reason, triggered_by_actor, unit_count, updated_at)
    VALUES (${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, ${vndrUuid}::uuid, 'BORN', 'LOT_SIZE', NULL, 1, now())
  `
  const entry = toUuid(newId('asgn'))
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, ship_to_contact_name, ship_to_mobile, qr_value, vpa_value, pool_status, batch, dispatch_state,
      source_event_id, trace_id, updated_at
    ) VALUES (
      ${entry}::uuid, ${tnnt}::uuid, ${prog}::uuid, true, 1, 0, true,
      'Acme Store', 'Acme Pvt Ltd', '5814', 'HDFC-001', 'HDFC Bank',
      ${SHIP_TO_ADDRESS}, 'Sherlock Holmes', '9999999999', 'acme@hdfcbank', 'acme@hdfcbank', 'BATCHED',
      ${btchUuid}::uuid, 'SENT_TO_VENDOR', 'evt-pull-1', 'trace-pull-1', now()
    )
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO composed_artifact (
      asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference,
      label_display_name, label_qr, created_at
    ) VALUES (
      ${entry}::uuid, ${btchUuid}::uuid, ${tnnt}::uuid, ${prog}::uuid, 'SOUNDBOX_IMG', 's3://labels/acme-1.pdf',
      'Acme Store', 'acme@hdfcbank', now()
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
    assetStore: new InMemoryAssetStore(),
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
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, unit, composed_artifact, pending_pool_entry, batch, vndr, credential_projection, outbox, inbox CASCADE',
  )
})

describe('GET /vendor/batch/:btchId/package (spec 14b task 7, FR-04 pull)', () => {
  it('an own-vndr pull returns 200 with the streamed .xlsx and an attachment Content-Disposition', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire } = await seedBatch(vndrWire)
    const token = await mint({ scope: { vndr: vndrWire } })

    const res = await request(app.getHttpServer())
      .get(`/vendor/batch/${btchWire}/package`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => callback(null, Buffer.concat(chunks)))
      })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="dispatch-${btchWire}.xlsx"`)
    const body = res.body as Buffer
    expect(Buffer.isBuffer(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    // a real xlsx is a PK zip; the first two bytes prove it, not a stub buffer.
    expect(body.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('a cross-vndr pull is rejected 403 and streams no xlsx', async () => {
    const ownerVndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const otherVndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire } = await seedBatch(ownerVndrWire)
    const token = await mint({ scope: { vndr: otherVndrWire } })

    const res = await request(app.getHttpServer())
      .get(`/vendor/batch/${btchWire}/package`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
    expect(res.headers['content-disposition']).toBeUndefined()
  })

  it('never logs the ship-to address, contact name, or mobile for an own-vndr pull', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire } = await seedBatch(vndrWire)
    const token = await mint({ scope: { vndr: vndrWire } })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await request(app.getHttpServer())
        .get(`/vendor/batch/${btchWire}/package`)
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => callback(null, Buffer.concat(chunks)))
        })
    } finally {
      const allCalls = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map((a) => JSON.stringify(a))
        .join('\n')
      logSpy.mockRestore()
      errSpy.mockRestore()
      warnSpy.mockRestore()
      expect(allCalls).not.toMatch(/Sherlock|Baker Street|9999999999/)
    }
  })
})

describe('GET /vendor/batch/:btchId/collateral/:artifactType (Phase 4 Task 4b, FR-04)', () => {
  it('an own-vndr pull is authorized (not 403): 404 here because the seeded artifact refs are not real stored PDFs', async () => {
    const vndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire } = await seedBatch(vndrWire)
    const token = await mint({ scope: { vndr: vndrWire } })

    const res = await request(app.getHttpServer())
      .get(`/vendor/batch/${btchWire}/collateral/SOUNDBOX_IMG`)
      .set('Authorization', `Bearer ${token}`)

    // authorized (would be 403 if not own-vndr); the batch's seeded artifact
    // references are placeholders not present in the asset store, so the merge
    // yields nothing -> 404. Real-PDF streaming is covered by the fulfillment
    // assembleTypePdf unit test.
    expect(res.status).toBe(404)
  })

  it('a cross-vndr collateral pull is rejected 403', async () => {
    const ownerVndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const otherVndrWire = fromUuid('vndr', toUuid(newId('vndr')))
    const { btchWire } = await seedBatch(ownerVndrWire)
    const token = await mint({ scope: { vndr: otherVndrWire } })

    const res = await request(app.getHttpServer())
      .get(`/vendor/batch/${btchWire}/collateral/SOUNDBOX_IMG`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(403)
  })
})
