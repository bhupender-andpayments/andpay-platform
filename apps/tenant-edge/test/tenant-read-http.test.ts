import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { buildTenantEdgeApp, type TenantEdgeDeps } from '../src/index.js'

// The REAL app, real in-process HTTP via supertest, no bound port. This suite
// exercises the Task-6 read controllers: server-side scope re-derivation (D99),
// the tenant's own ship-to PII in the HTTP response only (Fork F / check 8),
// and the per-read-decision 6e authz-audit emit (ALLOW on non-empty scope,
// DENY reasonCode 'empty-scope' on empty scope).
const EXPECTED_ISS = 'https://auth.andpay.test/tenant'
const KID = 'tenant-edge-read-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
// ADDITIVE (spec 11 task 8): TenantEdgeDeps now requires an analyticsDb; wired
// for construction only (this Task-6 read suite never exercises the reporting routes).
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// The seeded PII values (Fork F), asserted present in the HTTP body and ABSENT
// from every 6e outbox row and every console sink.
const PII_A = {
  contactName: 'Jane Doe',
  mobile: '+91-9000000001',
  shipToAddress: '221B Baker Street, Program A',
}
const PII_B = {
  contactName: 'John Roe',
  mobile: '+91-9000000002',
  shipToAddress: '42 Wallaby Way, Program B',
}

interface Seeded {
  asgnA: string
  asgnB: string
  progA: string
  progB: string
  progC: string
  tnntA: string
  shptA: string
  shptB: string
}

let seeded: Seeded

// Mint a live class-2 tenant-portal access token; the caller overrides the
// scope to drive the specific re-derivation under test.
async function mint(scope: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    sub: 'user_tenant_ops_1',
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

interface AuditRow {
  decision: string
  operation: string
  reasonCode: string | undefined
  cls: number
  principalId: string
  actorChannel: string | undefined
  resourceIds: string[] | undefined
}

async function auditRows(): Promise<AuditRow[]> {
  const rows = await fulfillmentDb.$queryRaw<
    {
      payload: {
        decision: string
        operation: string
        reasonCode?: string
        cls: number
        principalId: string
        actorChannel?: string
        resourceIds?: string[]
      }
    }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({
    decision: r.payload.decision,
    operation: r.payload.operation,
    reasonCode: r.payload.reasonCode,
    cls: r.payload.cls,
    principalId: r.payload.principalId,
    actorChannel: r.payload.actorChannel,
    resourceIds: r.payload.resourceIds,
  }))
}

async function rawAuditRows(): Promise<unknown[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: unknown }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => r.payload)
}

async function seed(): Promise<Seeded> {
  const asgnA = randomUUID()
  const asgnB = randomUUID()
  const mrchA = randomUUID()
  const mrchB = randomUUID()
  const progA = randomUUID()
  const progB = randomUUID()
  const progC = randomUUID()
  const tnntA = randomUUID()
  const tnntB = randomUUID()
  const shptA = randomUUID()
  const shptB = randomUUID()

  await tmsDb.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      contact_name, mobile, qr_value, vpa_value,
      soundbox, standee_count, sticker_count, billable,
      demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${asgnA}::uuid, ${mrchA}::uuid, ${progA}::uuid, ${tnntA}::uuid,
      'Acme A', 'Acme A Pvt Ltd', '5814',
      'HDFC', 'HDFC Bank', ${PII_A.shipToAddress},
      ${PII_A.contactName}, ${PII_A.mobile}, 'upi://pay?pa=acmea@hdfcbank', 'acmea@hdfcbank',
      true, 1, 2, true,
      'pooled-for-fulfillment', 'file-A|1', 'SOUNDBOX', now()
    )
  `
  await tmsDb.$executeRaw`
    INSERT INTO assignment (
      id, merchant_id, program_id, tenant_id,
      merchant_display_name, merchant_legal_name, merchant_mcc,
      bank_reference_code, bank_display_name, ship_to_address,
      contact_name, mobile, qr_value, vpa_value,
      soundbox, standee_count, sticker_count, billable,
      demand_state, source_event_id, dispatch_group, updated_at
    ) VALUES (
      ${asgnB}::uuid, ${mrchB}::uuid, ${progB}::uuid, ${tnntB}::uuid,
      'Acme B', 'Acme B Pvt Ltd', '5815',
      'ICICI', 'ICICI Bank', ${PII_B.shipToAddress},
      ${PII_B.contactName}, ${PII_B.mobile}, 'upi://pay?pa=acmeb@icicibank', 'acmeb@icicibank',
      false, 0, 1, true,
      'received', 'file-B|1', 'COLLATERAL', now()
    )
  `

  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptA}::uuid, 'AWB-A-1', NULL, 'IN_TRANSIT', now(), ${tnntA}::uuid, ${progA}::uuid, now())
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptB}::uuid, 'AWB-B-1', NULL, 'DISPATCHED_BY_VENDOR', now(), ${tnntB}::uuid, ${progB}::uuid, now())
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
    VALUES (${shptA}::uuid, ${progA}::uuid, 'OUT_FOR_DELIVERY', '2026-07-20T09:00:00Z'::timestamptz, 'WEBHOOK', 'ref-a-2', 'trace-a')
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
    VALUES (${shptA}::uuid, ${progA}::uuid, 'PICKED_UP', '2026-07-20T08:00:00Z'::timestamptz, 'BATCH_FILE', 'ref-a-1', 'trace-a')
  `
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
    VALUES (${shptB}::uuid, ${progB}::uuid, 'DISPATCHED_BY_VENDOR', '2026-07-19T08:00:00Z'::timestamptz, 'BATCH_FILE', 'ref-b-1', 'trace-b')
  `

  return { asgnA, asgnB, progA, progB, progC, tnntA, shptA, shptB }
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
    portalOrigin: 'https://tenant.andpay.test',
  }
  app = await buildTenantEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
  await analyticsDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE shpt_status_event, courier_status_exception, shpt, outbox, inbox CASCADE')
  await tmsDb.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
  seeded = await seed()
})

describe('tenant read edge: GET /tenant/assignments is scoped to the claim (D99, checks 3/5/6/8)', () => {
  it('returns ONLY the claim programs (C has no rows, B excluded) with own ship-to PII (Fork F)', async () => {
    // scope.pids = [A, C]: A has a row, C has none, B is NOT in the claim.
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA, seeded.progC] })
    const res = await request(app.getHttpServer()).get('/tenant/assignments').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    const row = res.body[0]
    expect(row.programId).toBe(seeded.progA)
    // Fork F: the tenant's own ship-to PII rides the HTTP response body only.
    expect(row.contactName).toBe(PII_A.contactName)
    expect(row.mobile).toBe(PII_A.mobile)
    expect(row.shipToAddress).toBe(PII_A.shipToAddress)
    expect(row.merchantDisplayName).toBe('Acme A')
    // B's PII must never appear.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(PII_B.contactName)
    expect(body).not.toContain(PII_B.mobile)
  })

  it('IGNORES an out-of-scope ?program_id= query param: result is claim-scoped regardless (D99, check 3)', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA, seeded.progC] })
    const res = await request(app.getHttpServer())
      .get(`/tenant/assignments?program_id=${seeded.progB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    // The spoofed out-of-scope param changes NOTHING: still A-only.
    expect(res.body).toHaveLength(1)
    expect(res.body[0].programId).toBe(seeded.progA)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(PII_B.contactName)
    expect(body).not.toContain('42 Wallaby Way')
  })

  it('IGNORES a spoofed program_id header AND body: result is claim-scoped regardless (D99)', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const res = await request(app.getHttpServer())
      .get('/tenant/assignments')
      .set('Authorization', `Bearer ${token}`)
      .set('x-program-id', seeded.progB)
      .set('program_id', seeded.progB)
      .send({ program_id: seeded.progB, tenant_id: randomUUID() })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].programId).toBe(seeded.progA)
  })

  it('emits exactly one read-ALLOW 6e (cls:2, human-direct, resourceIds = tenant+programs, NO PII in the record)', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA, seeded.progC] })
    const res = await request(app.getHttpServer()).get('/tenant/assignments').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('tenant:read-assignments')
    expect(rows[0]!.cls).toBe(2)
    expect(rows[0]!.principalId).toBe('user_tenant_ops_1')
    expect(rows[0]!.actorChannel).toBe('human-direct')
    expect(rows[0]!.resourceIds).toContain(seeded.tnntA)
    expect(rows[0]!.resourceIds).toContain(seeded.progA)
    expect(rows[0]!.resourceIds).toContain(seeded.progC)

    // IDs-only 6e: PII lives in the HTTP body only, never the audit record.
    const raw = JSON.stringify(await rawAuditRows())
    expect(raw).not.toContain(PII_A.contactName)
    expect(raw).not.toContain(PII_A.mobile)
    expect(raw).not.toContain(PII_A.shipToAddress)
  })

  it('an empty-scope claim (pids absent) -> 403 + exactly one read-DENY 6e (reasonCode empty-scope)', async () => {
    const token = await mint({ tid: seeded.tnntA })
    const res = await request(app.getHttpServer()).get('/tenant/assignments').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('tenant:read-assignments')
    expect(rows[0]!.reasonCode).toBe('empty-scope')
    expect(rows[0]!.cls).toBe(2)
    expect(rows[0]!.actorChannel).toBe('human-direct')
  })

  it('an empty-scope claim (pids: []) -> 403 + one read-DENY 6e', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [] })
    const res = await request(app.getHttpServer()).get('/tenant/assignments').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('empty-scope')
  })

  it('redaction: no console sink is ever called with any PII value on a successful read (check 8)', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ]
    try {
      const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
      const res = await request(app.getHttpServer()).get('/tenant/assignments').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      const piiValues = [PII_A.contactName, PII_A.mobile, PII_A.shipToAddress]
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const line = call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
          for (const pii of piiValues) expect(line).not.toContain(pii)
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('tenant read edge: GET /tenant/assignments/:id detail (D99, 404 on out-of-scope)', () => {
  it('returns an in-scope row (with own PII); an out-of-scope :id -> 404', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const inScope = await request(app.getHttpServer())
      .get(`/tenant/assignments/${seeded.asgnA}`)
      .set('Authorization', `Bearer ${token}`)
    expect(inScope.status).toBe(200)
    expect(inScope.body.id).toBe(seeded.asgnA)
    expect(inScope.body.contactName).toBe(PII_A.contactName)

    // B's assignment id is out of the claim scope -> 404, never a leak.
    const outOfScope = await request(app.getHttpServer())
      .get(`/tenant/assignments/${seeded.asgnB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(outOfScope.status).toBe(404)
    expect(JSON.stringify(outOfScope.body)).not.toContain(PII_B.contactName)
  })
})

describe('tenant read edge: GET /tenant/shipments mirrors the assignment scoping (D99)', () => {
  it('returns only claim-program shipments; ignores a spoofed ?program_id=', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA, seeded.progC] })
    const res = await request(app.getHttpServer())
      .get(`/tenant/shipments?program_id=${seeded.progB}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].programId).toBe(seeded.progA)
    expect(res.body[0].awb).toBe('AWB-A-1')

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('tenant:read-shipments')
  })

  it('an empty-scope claim -> 403 + one read-DENY 6e for tenant:read-shipments', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [] })
    const res = await request(app.getHttpServer()).get('/tenant/shipments').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('tenant:read-shipments')
    expect(rows[0]!.reasonCode).toBe('empty-scope')
  })
})

describe('tenant read edge: GET /tenant/shipments/:id/status trail (D99)', () => {
  it('returns the ascending trail for an in-scope shpt; [] for an out-of-scope shpt', async () => {
    const token = await mint({ tid: seeded.tnntA, pids: [seeded.progA] })
    const inScope = await request(app.getHttpServer())
      .get(`/tenant/shipments/${seeded.shptA}/status`)
      .set('Authorization', `Bearer ${token}`)
    expect(inScope.status).toBe(200)
    expect(inScope.body).toHaveLength(2)
    expect(inScope.body[0].status).toBe('PICKED_UP')
    expect(inScope.body[1].status).toBe('OUT_FOR_DELIVERY')

    // shptB belongs to program B, not in the claim -> empty trail, never a leak.
    const outOfScope = await request(app.getHttpServer())
      .get(`/tenant/shipments/${seeded.shptB}/status`)
      .set('Authorization', `Bearer ${token}`)
    expect(outOfScope.status).toBe(200)
    expect(outOfScope.body).toEqual([])

    const rows = await auditRows()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.operation === 'tenant:read-shipment-status')).toBe(true)
    expect(rows.every((r) => r.decision === 'ALLOW')).toBe(true)
  })
})
