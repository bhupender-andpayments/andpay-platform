import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import type { AuthzAuditRecord } from '@andpay/audit'
import {
  PrismaClient as AuthClient,
  consumeAuthzAudit,
  verifyAuthzChain,
  AUTHZ_AUDIT_CONSUMER,
} from '@andpay/auth-service'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { buildTenantEdgeApp, type TenantEdgeDeps } from '@andpay/tenant-edge'

// Root-only integration seam (mirrors test/authz_audit_chain_e2e.test.ts's
// check-2 precedent, and apps/tenant-edge/test/tenant-read-http.test.ts's
// live-HTTP pattern): proves the FULL Task-6/Task-7 path end to end for tenant
// reads -- a REAL read decision, driven over HTTP through the tenant edge,
// lands in fulfillment's outbox as an authz.audit row, and Auth's UNCHANGED
// 10a consumer (consumeAuthzAudit) appends it to the tamper-evident
// hash-chain, with verifyAuthzChain reporting ok and a redelivery of the same
// payload.id a strict no-op (E6 dedup). This reuses consumeAuthzAudit and
// verifyAuthzChain verbatim: a class-2 human-direct record chains through the
// exact same appender as any other class, with zero new consumer wiring.
const EXPECTED_ISS = 'https://auth.andpay.test/tenant'
const KID = 'tenant-edge-chain-e2e-key-1'

const authUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'

const authDb = new AuthClient({ datasourceUrl: authUrl })
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
// ADDITIVE (spec 11 task 8): TenantEdgeDeps now requires an analyticsDb; wired
// for construction only (this read-chain e2e never exercises the reporting routes).
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// The seeded PII (Fork F), asserted present nowhere in the emitted 6e record:
// the read decision is IDs-and-enums only (S7/S10.5), even though the
// underlying query result genuinely contains this PII.
const PII_A = {
  contactName: 'Priya Iyer',
  mobile: '+91-9000000099',
  shipToAddress: '17 MG Road, Program A Warehouse',
}

interface Seeded {
  progA: string
  tnntA: string
}

async function seed(): Promise<Seeded> {
  const asgnA = randomUUID()
  const mrchA = randomUUID()
  const progA = randomUUID()
  const tnntA = randomUUID()

  await tmsDb.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      contact_name, mobile, qr_value, vpa_value,
      soundbox, standee_count, sticker_count, billable,
      demand_state, source_event_id, updated_at
    ) VALUES (
      ${asgnA}::uuid, ${mrchA}::uuid, ${progA}::uuid, ${tnntA}::uuid,
      'Acme A', 'Acme A Pvt Ltd', '5814',
      'HDFC', 'HDFC Bank', ${PII_A.shipToAddress},
      ${PII_A.contactName}, ${PII_A.mobile}, 'upi://pay?pa=acmea@hdfcbank', 'acmea@hdfcbank',
      true, 1, 2, true,
      'pooled-for-fulfillment', 'file-A|1', now()
    )
  `
  return { progA, tnntA }
}

let seeded: Seeded

// Mint a live class-2 tenant-portal access token; the caller supplies the
// scope to drive either a non-empty (ALLOW) or empty (DENY) read decision.
async function mint(scope: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'user_tenant_ops_e2e',
    cls: 2,
    mode: 'live',
    aud: 'andpay:tenant-portal',
    scope,
    psr: 'pset:tenant_ops',
    epoch: 1,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KID })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .setIssuer(EXPECTED_ISS)
    .sign(privateKey)
}

type AuditOutboxRow = { payload: { id: string } & AuthzAuditRecord }

async function readAuditOutbox(): Promise<AuditOutboxRow[]> {
  return fulfillmentDb.$queryRaw<AuditOutboxRow[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  const jwks: JSONWebKeySet = { keys: [jwk] }

  const deps: TenantEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
    jwks,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
  }
  app = await buildTenantEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await authDb.$disconnect()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
})

beforeEach(async () => {
  // The chain and its own E6 inbox rows: the chain must start empty (seq from
  // 1, prev from GENESIS) for every test in this file.
  await authDb.$executeRaw`DELETE FROM authz_audit`
  await authDb.$executeRawUnsafe(`DELETE FROM inbox WHERE consumer = '${AUTHZ_AUDIT_CONSUMER}'`)
  // The fulfillment outbox/inbox this test reads the delivered payload from,
  // and the tms/fulfillment domain rows the read decision is authorized over.
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox')
  await tmsDb.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
  seeded = await seed()
})

describe('6e authz-audit chain e2e for tenant read decisions (task 7, LOAD-BEARING)', () => {
  it('a real ALLOW read and a real empty-scope DENY read chain via the UNCHANGED 10a consumer, verify ok, and dedup on redelivery', async () => {
    // (a) a REAL successful read over HTTP: a live class-2 tenant-portal
    // token, scope.pids = [progA] -> 200. The controller's authorize() step
    // emits ONE read-ALLOW 6e into the fulfillment outbox (Task 6, D-7).
    const allowToken = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const allowRes = await request(app.getHttpServer())
      .get('/tenant/assignments')
      .set('Authorization', `Bearer ${allowToken}`)
    expect(allowRes.status).toBe(200)
    expect(allowRes.body).toHaveLength(1)
    // Sanity: the read genuinely touched real PII in the response body (Fork
    // F), so the "IDs-only in the audit record" assertion below is meaningful
    // rather than vacuous.
    expect(allowRes.body[0].contactName).toBe(PII_A.contactName)

    // (b) a REAL empty-scope read over HTTP: pids: [] -> 403. The
    // controller's authorize() step emits ONE read-DENY 6e (reasonCode
    // 'empty-scope') before any database access.
    const denyToken = await mint({ tid: seeded.tnntA, pids: [] })
    const denyRes = await request(app.getHttpServer())
      .get('/tenant/assignments')
      .set('Authorization', `Bearer ${denyToken}`)
    expect(denyRes.status).toBe(403)

    // Read BOTH delivered payloads from the fulfillment outbox: the actual
    // persisted rows, not a re-minted fixture.
    const rows = await readAuditOutbox()
    expect(rows).toHaveLength(2)
    const allowPayload = rows[0]!.payload
    const denyPayload = rows[1]!.payload

    // IDs-only (S7/S10.5): the record matches NO PII value and NO apsk_
    // credential, even though the underlying read genuinely returned PII.
    const raw = JSON.stringify(rows.map((r) => r.payload))
    expect(raw).not.toContain(PII_A.contactName)
    expect(raw).not.toContain(PII_A.mobile)
    expect(raw).not.toContain(PII_A.shipToAddress)
    expect(raw).not.toContain('apsk_')

    // D-7 shape assertions on the ALLOW record.
    expect(allowPayload.decision).toBe('ALLOW')
    expect(allowPayload.cls).toBe(2)
    expect(allowPayload.principalId).toBe('user_tenant_ops_e2e')
    expect(allowPayload.actorChannel).toBe('human-direct')
    expect(allowPayload.operation).toBe('tenant:read-assignments')
    expect(allowPayload.resourceIds).toContain(seeded.tnntA)
    expect(allowPayload.resourceIds).toContain(seeded.progA)

    // D-7 shape assertions on the DENY record.
    expect(denyPayload.decision).toBe('DENY')
    expect(denyPayload.reasonCode).toBe('empty-scope')
    expect(denyPayload.cls).toBe(2)
    expect(denyPayload.actorChannel).toBe('human-direct')

    // The chain starts empty.
    const before = await verifyAuthzChain(authDb)
    expect(before).toEqual({ ok: true, length: 0 })

    // Consume both delivered payloads through the UNCHANGED Auth-side
    // consumer, in emission order: the chain grows by exactly 2, gap-free,
    // chaining from GENESIS.
    const allowResult = await consumeAuthzAudit(authDb, allowPayload)
    expect(allowResult).toEqual({ appended: true, seq: 1 })
    const denyResult = await consumeAuthzAudit(authDb, denyPayload)
    expect(denyResult).toEqual({ appended: true, seq: 2 })

    const chainRows = await authDb.$queryRaw<{ seq: bigint; prev_hash: string; entry_hash: string }[]>`
      SELECT seq, prev_hash, entry_hash FROM authz_audit ORDER BY seq ASC
    `
    expect(chainRows).toHaveLength(2)
    expect(chainRows[0]!.prev_hash).toBe('0'.repeat(64))
    expect(chainRows[1]!.prev_hash).toBe(chainRows[0]!.entry_hash)

    const verified = await verifyAuthzChain(authDb)
    expect(verified).toEqual({ ok: true, length: 2 })

    // Redelivery of the SAME allowPayload.id (never a re-minted id) is a
    // strict no-op: no double-append, count stable, chain still verifies.
    const redelivered = await consumeAuthzAudit(authDb, allowPayload)
    expect(redelivered).toEqual({ appended: false })
    const countAfter = await authDb.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM authz_audit`
    expect(Number(countAfter[0]!.n)).toBe(2)
    const verifiedAfter = await verifyAuthzChain(authDb)
    expect(verifiedAfter).toEqual({ ok: true, length: 2 })
  })
})
