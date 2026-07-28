import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient as FulfillmentClient, loadOpsConfig } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// The REAL app, real in-process HTTP via supertest against app.getHttpServer(),
// no bound port. This suite exercises the Task-9 Part-B ops ACTION controllers:
// the per-action STEP-UP gate (403 + step-up-required 6e DENY on a stale/weak
// claim, the action runs + ALLOW 6e on a fresh AAL2 claim), the D2 authorize
// gate (403 + DENY 6e, no domain effect), the audit-AFTER-success ALLOW 6e (IDs
// and enums only, cls:3, human-direct), the Fork-D client action key (400 on a
// missing Idempotency-Key, NOT a 6e), and the isKnownStatus defense-in-depth
// (400 before any domain write). T10 owns the exhaustive per-route 6e chain.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-actions-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// Mint a live class-3 internal-admin access token. Defaults to a FRESH AAL2
// human claim carrying the ops_portal role (psr `role:ops_portal`, so the D2
// authorize resolves the ops role); a caller overrides acr / auth_time / psr to
// drive a specific step-up or authz rejection.
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
  reasonCode: string | undefined
  cls: number
  principalId: string
  actorChannel: string | undefined
  resourceIds: string[] | undefined
  acr: string | undefined
  authTime: number | undefined
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
        acr?: string
        authTime?: number
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
    acr: r.payload.acr,
    authTime: r.payload.authTime,
  }))
}

async function rawAuditRows(): Promise<unknown[]> {
  const rows = await fulfillmentDb.$queryRaw<{ payload: unknown }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => r.payload)
}

// Seed one shpt (owner insert, mirrors the tenant-edge read test's shape). No
// status_at is set, so the correct-path advance UPDATE's `status_at IS NULL`
// guard is satisfied and a forward correction advances.
async function seedShpt(status: string): Promise<{ shptId: string; programId: string }> {
  const shptId = randomUUID()
  const programId = randomUUID()
  const tenantId = randomUUID()
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptId}::uuid, ${'AWB-' + shptId.slice(0, 8)}, NULL, ${status}, now(), ${tenantId}::uuid, ${programId}::uuid, now())
  `
  return { shptId, programId }
}

async function shptStatus(shptId: string): Promise<string> {
  const rows = await fulfillmentDb.$queryRaw<{ status: string }[]>`
    SELECT status FROM shpt WHERE id = ${shptId}::uuid
  `
  return rows[0]!.status
}

// Seed one pending_pool_entry (mirrors services/fulfillment/test/ops-actions.test.ts's
// seedPooled), for the recompose-with-changed-ship-to 4xx test below: it needs a
// real current ship-to to diverge from.
async function seedPendingPoolEntry(shipToAddress: string): Promise<{ asgnWire: string; asgnUuid: string; programId: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const tenantId = randomUUID()
  const programId = randomUUID()
  await fulfillmentDb.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantId}::uuid, ${programId}::uuid, true, 1, 1, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', ${shipToAddress},
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', 'file-1|1', 'trace-1', now(), now()
    )
  `
  return { asgnWire, asgnUuid, programId }
}

// Seed the one non-superseded composed_artifact row recomposeArtifact's target
// resolution requires (mirrors services/fulfillment/test/ops-actions.test.ts's
// seedComposedArtifact).
async function seedComposedArtifact(asgnUuid: string, programId: string): Promise<{ id: string }> {
  const tenantId = randomUUID()
  const btchId = randomUUID()
  const rows = await fulfillmentDb.$queryRaw<{ id: string }[]>`
    INSERT INTO composed_artifact
      (id, asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr, bank_config_ref, created_at)
    VALUES
      (gen_random_uuid(), ${asgnUuid}::uuid, ${btchId}::uuid, ${tenantId}::uuid, ${programId}::uuid,
       'SOUNDBOX_IMG', 'ref/soundbox-1', 'Acme', 'upi://pay?pa=acme@hdfcbank', NULL::uuid, now())
    RETURNING id::text AS id
  `
  return { id: rows[0]!.id }
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
    jwks,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
    roleConfig: loadOpsConfig(),
  }
  app = await buildOpsEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, pending_pool_entry, composed_artifact, outbox, inbox CASCADE',
  )
})

describe('ops-edge actions: the per-action step-up gate (check 1)', () => {
  it('POST override with a STALE auth_time -> 403 + one step-up-required 6e DENY, no domain op', async () => {
    const now = Math.floor(Date.now() / 1000)
    // AAL2 but auth_time older than the terminal-override freshness (300s).
    const token = await mint({ auth_time: now - 1000 })
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'x' })
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('ops:terminal-override')
    expect(rows[0]!.reasonCode).toBe('step-up-required')
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.actorChannel).toBe('human-direct')
  })

  it('POST override with acr AAL1 (below AAL2) -> 403 + step-up-required 6e DENY', async () => {
    const token = await mint({ acr: 'AAL1' })
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'x' })
    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('step-up-required')
    expect(rows[0]!.operation).toBe('ops:terminal-override')
  })

  it('POST release with a stale auth_time -> 403 + step-up-required 6e DENY (ops:record-release)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mint({ auth_time: now - 1000 })
    const res = await request(app.getHttpServer())
      .post(`/ops/records/asgn_${randomUUID().replace(/-/g, '')}/release`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({})
    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('step-up-required')
    expect(rows[0]!.operation).toBe('ops:record-release')
  })

  it('POST vendor suspend with a stale auth_time -> 403 + step-up-required 6e DENY (ops:vendor-suspend)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mint({ auth_time: now - 1000 })
    const res = await request(app.getHttpServer())
      .post(`/ops/vendors/vndr_${randomUUID().replace(/-/g, '')}/suspend`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({})
    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('step-up-required')
    expect(rows[0]!.operation).toBe('ops:vendor-suspend')
  })

  it('POST override with a FRESH AAL2 claim -> the action runs (200) and emits ONE terminal-override ALLOW 6e', async () => {
    const { shptId } = await seedShpt('IN_TRANSIT')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'lost in transit, reissued manually' })
    expect(res.status).toBe(200)
    expect(res.body.overridden).toBe(true)
    // The raw C3 bypass took effect.
    expect(await shptStatus(shptId)).toBe('DELIVERED')

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('ops:terminal-override')
    expect(rows[0]!.reasonCode).toBe('terminal-override')
    expect(rows[0]!.acr).toBe('AAL2')
    expect(typeof rows[0]!.authTime).toBe('number')
    expect(rows[0]!.resourceIds).toEqual([shptId])
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.actorChannel).toBe('human-direct')

    // DD1: the free-text override reason lives ONLY on the domain row, never
    // the 6e record.
    const raw = JSON.stringify(await rawAuditRows())
    expect(raw).not.toContain('lost in transit')
  })
})

describe('ops-edge actions: the D2 authorize gate (check 2)', () => {
  it('a class-3 claim whose psr resolves to no ops role -> 403 + one DENY 6e, no domain effect', async () => {
    const { shptId } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(403)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('ops:status-correction')
    // The only in-config ops role holds every ops permission, so the reachable
    // authz-deny for a class-3 human is the unknown-role miss (the psr does not
    // resolve to any configured role), not a per-permission miss.
    expect(rows[0]!.reasonCode).toBe('unknown-role')
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.actorChannel).toBe('human-direct')

    // No domain effect: the shpt is untouched.
    expect(await shptStatus(shptId)).toBe('DISPATCHED_BY_VENDOR')
  })
})

describe('ops-edge actions: a representative ALLOW mutation end-to-end (check 3)', () => {
  it('POST correct on a fresh AAL2 claim runs, advances the shpt, and emits exactly ONE ALLOW 6e (IDs-only)', async () => {
    const { shptId } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(200)
    // The correction advanced the ladder (a non-catalog action needs no step-up).
    expect(await shptStatus(shptId)).toBe('IN_TRANSIT')

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('ops:status-correction')
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.actorChannel).toBe('human-direct')
    expect(rows[0]!.principalId).toBe('user_ops_1')
    expect(rows[0]!.resourceIds).toEqual([shptId])
    // A non-override ALLOW carries no reasonCode and no assurance fields.
    expect(rows[0]!.reasonCode).toBeUndefined()
    expect(rows[0]!.acr).toBeUndefined()
  })
})

describe('ops-edge actions: the Fork-D client action key is mandatory (check 4)', () => {
  it('POST correct with NO Idempotency-Key header -> 400 and emits NO 6e (a 400, not a 6e-DENY)', async () => {
    const { shptId } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(400)
    expect(await auditRows()).toHaveLength(0)
    // No domain effect.
    expect(await shptStatus(shptId)).toBe('DISPATCHED_BY_VENDOR')
  })
})

describe('ops-edge actions: isKnownStatus rejects a garbage target status before any domain write (check 5)', () => {
  it('POST correct with an unknown status -> 400 before the domain op, NO 6e, no domain effect', async () => {
    const { shptId } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'NOT_A_REAL_STATUS', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(400)
    // The gate passed (a valid claim), but status validation threw BEFORE the
    // domain op and BEFORE any ALLOW emit, so there is no 6e at all.
    expect(await auditRows()).toHaveLength(0)
    expect(await shptStatus(shptId)).toBe('DISPATCHED_BY_VENDOR')
  })

  it('POST override with an unknown status (fresh AAL2) -> 400 after the step-up gate, NO 6e, no domain effect', async () => {
    const { shptId } = await seedShpt('IN_TRANSIT')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'GARBAGE', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'x' })
    expect(res.status).toBe(400)
    expect(await auditRows()).toHaveLength(0)
    expect(await shptStatus(shptId)).toBe('IN_TRANSIT')
  })
})

// Fix wave 1 (Task 9 review, Important 1): the fulfillment ops domain throws
// `OpsClientError` for an expected client condition (a missing target, a bad
// request shape); the new app-wide `OpsErrorFilter` (registered via APP_FILTER
// in app.module.ts) maps `kind: 'not-found'` to 404 and `kind: 'invalid'` to
// 400. Before this filter, none of these reached the controller's own
// try/catch (there is none), so Nest's default fell through to a 500 for each
// of these. Every case here uses a FRESH AAL2 claim so the request clears the
// step-up gate (where applicable) and the D2 authorize gate, and reaches the
// domain op itself.
describe('ops-edge actions: domain client-errors map to 4xx via the OpsErrorFilter (Fix wave 1, Important 1)', () => {
  it('POST correct with a non-existent shptId -> 404, not 500', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(404)
  })

  it('POST override with a non-existent shptId (fresh AAL2, valid reason) -> 404, not 500', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        status: 'DELIVERED',
        courierTimestamp: '2026-07-27T10:00:00Z',
        overrideReason: 'lost in transit, reissued manually',
      })
    expect(res.status).toBe(404)
  })

  it('POST override with an EMPTY overrideReason (fresh AAL2, real shpt) -> 400, not 500', async () => {
    const { shptId } = await seedShpt('IN_TRANSIT')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptId}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: '   ' })
    expect(res.status).toBe(400)
    // No domain effect: the reason check throws before the C3 bypass UPDATE.
    expect(await shptStatus(shptId)).toBe('IN_TRANSIT')
  })

  it('POST recompose with a requestedShipTo that DIFFERS from the current ship-to -> 400, not 500', async () => {
    const { asgnWire, asgnUuid, programId } = await seedPendingPoolEntry('Original Address')
    await seedComposedArtifact(asgnUuid, programId)
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post('/ops/artifacts/recompose')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ asgnId: asgnWire, artifactType: 'SOUNDBOX_IMG', requestedShipTo: 'Changed Address' })
    expect(res.status).toBe(400)
  })

  it('POST hold with a non-existent asgnId -> 404, not 500', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${newId('asgn')}/hold`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({})
    expect(res.status).toBe(404)
  })

  it('POST release with a non-existent asgnId (fresh AAL2) -> 404, not 500', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${newId('asgn')}/release`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({})
    expect(res.status).toBe(404)
  })
})
