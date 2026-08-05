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
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
// ADDITIVE (spec 11 task 8): the reporting routes require an analyticsDb in
// deps. This suite does not exercise them, but OpsEdgeDeps now requires the
// field, so it is wired here for construction (never queried by this suite).
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({
  datasourceUrl: process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

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
// guard is satisfied and a forward correction advances. The domain writes now
// DECODE a wire shpt id (this task's contract change), so this returns both
// the wire form (for the route URL / resourceIds assertions) and the raw
// uuid (for direct DB assertions).
async function seedShpt(status: string): Promise<{ shptWire: string; shptUuid: string; programId: string }> {
  const shptWire = newId('shpt')
  const shptUuid = toUuid(shptWire)
  const programId = randomUUID()
  const tenantId = randomUUID()
  // A UUIDv7 id's leading bytes are a wall-clock timestamp (millisecond
  // resolution), not random, so deriving the awb from a slice of shptUuid (as
  // the pre-existing raw-uuid v4 id allowed) can collide across two shpt seeds
  // minted close together. Use an independent random source instead.
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptUuid}::uuid, ${'AWB-' + randomUUID()}, NULL, ${status}, now(), ${tenantId}::uuid, ${programId}::uuid, now())
  `
  return { shptWire, shptUuid, programId }
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
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, pending_pool_entry, composed_artifact, outbox, inbox CASCADE',
  )
})

describe('ops-edge FR08-2 damage case-status routes (wiring + gate)', () => {
  // A 400 here (not 403) proves BOTH that ops:update-damage-case is granted to
  // role:ops_portal (authz passes) AND that the route is mounted and the client-
  // action-key gate fires on a missing Idempotency-Key, before any domain write.
  it('POST damage-case-status without an Idempotency-Key -> 400 (authz passed, gate rejects), no 6e', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${newId('asgn')}/damage-case-status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'Closed' })
    expect(res.status).toBe(400)
  })

  it('GET damage-cases with a fresh AAL2 claim -> 200 and an array body', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer()).get('/ops/damage-cases').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
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
    const { shptWire, shptUuid } = await seedShpt('IN_TRANSIT')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'lost in transit, reissued manually' })
    expect(res.status).toBe(200)
    expect(res.body.overridden).toBe(true)
    // The raw C3 bypass took effect.
    expect(await shptStatus(shptUuid)).toBe('DELIVERED')

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('ops:terminal-override')
    expect(rows[0]!.reasonCode).toBe('terminal-override')
    expect(rows[0]!.acr).toBe('AAL2')
    expect(typeof rows[0]!.authTime).toBe('number')
    expect(rows[0]!.resourceIds).toEqual([shptWire])
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
    const { shptWire, shptUuid } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/correct`)
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
    expect(await shptStatus(shptUuid)).toBe('DISPATCHED_BY_VENDOR')
  })
})

describe('ops-edge actions: a representative ALLOW mutation end-to-end (check 3)', () => {
  it('POST correct on a fresh AAL2 claim runs, advances the shpt, and emits exactly ONE ALLOW 6e (IDs-only)', async () => {
    const { shptWire, shptUuid } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(200)
    // The correction advanced the ladder (a non-catalog action needs no step-up).
    expect(await shptStatus(shptUuid)).toBe('IN_TRANSIT')

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('ALLOW')
    expect(rows[0]!.operation).toBe('ops:status-correction')
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.actorChannel).toBe('human-direct')
    expect(rows[0]!.principalId).toBe('user_ops_1')
    expect(rows[0]!.resourceIds).toEqual([shptWire])
    // A non-override ALLOW carries no reasonCode and no assurance fields.
    expect(rows[0]!.reasonCode).toBeUndefined()
    expect(rows[0]!.acr).toBeUndefined()
  })
})

describe('ops-edge actions: the Fork-D client action key is mandatory (check 4)', () => {
  it('POST correct with NO Idempotency-Key header -> 400 and emits NO 6e (a 400, not a 6e-DENY)', async () => {
    const { shptWire, shptUuid } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(400)
    expect(await auditRows()).toHaveLength(0)
    // No domain effect.
    expect(await shptStatus(shptUuid)).toBe('DISPATCHED_BY_VENDOR')
  })
})

describe('ops-edge actions: isKnownStatus rejects a garbage target status before any domain write (check 5)', () => {
  it('POST correct with an unknown status -> 400 before the domain op, NO 6e, no domain effect', async () => {
    const { shptWire, shptUuid } = await seedShpt('DISPATCHED_BY_VENDOR')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'NOT_A_REAL_STATUS', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(400)
    // The gate passed (a valid claim), but status validation threw BEFORE the
    // domain op and BEFORE any ALLOW emit, so there is no 6e at all.
    expect(await auditRows()).toHaveLength(0)
    expect(await shptStatus(shptUuid)).toBe('DISPATCHED_BY_VENDOR')
  })

  it('POST override with an unknown status (fresh AAL2) -> 400 after the step-up gate, NO 6e, no domain effect', async () => {
    const { shptWire, shptUuid } = await seedShpt('IN_TRANSIT')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'GARBAGE', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'x' })
    expect(res.status).toBe(400)
    expect(await auditRows()).toHaveLength(0)
    expect(await shptStatus(shptUuid)).toBe('IN_TRANSIT')
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
      // A well-formed but never-seeded wire shpt id: decodes fine, then
      // resolveProgramAndAwb's own not-found throw maps to 404 (a raw,
      // undecodable id would instead throw InvalidIdError, an unrelated 500).
      .post(`/ops/shipments/${newId('shpt')}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'IN_TRANSIT', courierTimestamp: '2026-07-27T10:00:00Z' })
    expect(res.status).toBe(404)
  })

  it('POST override with a non-existent shptId (fresh AAL2, valid reason) -> 404, not 500', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${newId('shpt')}/override`)
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
    const { shptWire, shptUuid } = await seedShpt('IN_TRANSIT')
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/shipments/${shptWire}/override`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: '   ' })
    expect(res.status).toBe(400)
    // No domain effect: the reason check throws before the C3 bypass UPDATE.
    expect(await shptStatus(shptUuid)).toBe('IN_TRANSIT')
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

// Phase 3 Task 1 (BRD FR-08, FR-11): the damage_reason master admin CRUD
// routes. This is a TMS-domain action (unlike every other route in this
// file, which is fulfillment-domain), so its co-committed ALLOW 6e lands in
// the TMS outbox, NOT fulfillmentDb's (C4: no cross-schema write); the DENY
// 6e from the shared edge gate() still lands in fulfillmentDb's outbox
// regardless of domain (emitOpsAuthzAudit is always called with
// this.deps.fulfillmentDb in ops.controller.ts). damage_reason is reference
// data seeded by migration, never truncated by this file's beforeEach (which
// only truncates fulfillment tables), so every row created here is deleted
// BY ID in a `finally`.
describe('ops-edge actions: damage_reason admin CRUD (Phase 3 Task 1)', () => {
  // Filters on BOTH operation and the exact target resource id (not operation
  // alone): the TMS outbox is never truncated by this file's beforeEach
  // (which only truncates fulfillment tables), and other TMS-domain test
  // files (e.g. services/tms/test/damage-reason.test.ts) write the SAME
  // operation strings against their OWN ids when the whole workspace suite
  // runs as one serial vitest invocation. Scoping to `id` keeps this
  // assertion correct regardless of run order or what else has run before it.
  async function tmsAuditRowsFor(operation: string, id: string): Promise<{ decision: string; resourceIds: string[] }[]> {
    const rows = await tmsDb.$queryRaw<{ payload: { decision: string; operation: string; resourceIds?: string[] } }[]>`
      SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
    return rows
      .filter((r) => r.payload.operation === operation && (r.payload.resourceIds ?? []).includes(id))
      .map((r) => ({ decision: r.payload.decision, resourceIds: r.payload.resourceIds ?? [] }))
  }

  async function deleteDamageReason(id: string): Promise<void> {
    await tmsDb.$executeRaw`DELETE FROM damage_reason WHERE id = ${id}::uuid`
  }

  it('a class-3 claim whose psr resolves to no ops role -> 403 + DENY 6e (fulfillment outbox), no domain effect', async () => {
    const token = await mint({ psr: 'role:not_ops' })
    const res = await request(app.getHttpServer())
      .post('/ops/damage-reasons')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ code: `unauthorized_${randomUUID()}`, label: `Unauthorized ${randomUUID()}` })
    expect(res.status).toBe(403)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('ops:damage-reason-create')
    expect(rows[0]!.reasonCode).toBe('unknown-role')
    // No domain effect: no row was created under that code.
    const created = await tmsDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM damage_reason WHERE code LIKE 'unauthorized_%'`
    expect(Number(created[0]!.n)).toBe(0)
  })

  it('POST damage-reasons with a fresh AAL2 claim creates the row (200) and emits ONE ALLOW 6e in the TMS outbox (no step-up needed)', async () => {
    const token = await mint({})
    const code = `test_${randomUUID()}`
    const label = `Test Reason ${randomUUID()}`
    const res = await request(app.getHttpServer())
      .post('/ops/damage-reasons')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ code, label })
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    expect(res.body.damageReason.code).toBe(code)
    expect(res.body.damageReason.label).toBe(label)
    expect(res.body.damageReason.active).toBe(true)
    const id = res.body.damageReason.id as string
    try {
      const rows = await tmsAuditRowsFor('ops:damage-reason-create', id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.decision).toBe('ALLOW')
      expect(rows[0]!.resourceIds).toEqual([id])
      // No DENY landed in the fulfillment outbox for this ALLOW path.
      expect(await auditRows()).toHaveLength(0)
    } finally {
      await deleteDamageReason(id)
    }
  })

  it('POST damage-reasons/:id/deactivate then /activate: each emits its own ALLOW 6e; an unauthorized role is rejected on deactivate', async () => {
    const createToken = await mint({})
    const code = `test_${randomUUID()}`
    const label = `Test Reason ${randomUUID()}`
    const createRes = await request(app.getHttpServer())
      .post('/ops/damage-reasons')
      .set('Authorization', `Bearer ${createToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ code, label })
    const id = createRes.body.damageReason.id as string
    try {
      const unauthToken = await mint({ psr: 'role:not_ops' })
      const deniedRes = await request(app.getHttpServer())
        .post(`/ops/damage-reasons/${id}/deactivate`)
        .set('Authorization', `Bearer ${unauthToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({})
      expect(deniedRes.status).toBe(403)
      expect((await tmsAuditRowsFor('ops:damage-reason-deactivate', id)).length).toBe(0)

      const deactivateToken = await mint({})
      const deactivateRes = await request(app.getHttpServer())
        .post(`/ops/damage-reasons/${id}/deactivate`)
        .set('Authorization', `Bearer ${deactivateToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({})
      expect(deactivateRes.status).toBe(200)
      expect(deactivateRes.body.deduped).toBe(false)
      const deactivateAudit = await tmsAuditRowsFor('ops:damage-reason-deactivate', id)
      expect(deactivateAudit).toHaveLength(1)
      expect(deactivateAudit[0]!.decision).toBe('ALLOW')
      expect(deactivateAudit[0]!.resourceIds).toEqual([id])
      const afterDeactivate = await tmsDb.$queryRaw<{ active: boolean }[]>`SELECT active FROM damage_reason WHERE id = ${id}::uuid`
      expect(afterDeactivate[0]!.active).toBe(false)

      const activateToken = await mint({})
      const activateRes = await request(app.getHttpServer())
        .post(`/ops/damage-reasons/${id}/activate`)
        .set('Authorization', `Bearer ${activateToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({})
      expect(activateRes.status).toBe(200)
      const activateAudit = await tmsAuditRowsFor('ops:damage-reason-activate', id)
      expect(activateAudit).toHaveLength(1)
      expect(activateAudit[0]!.decision).toBe('ALLOW')
      expect(activateAudit[0]!.resourceIds).toEqual([id])
      const afterActivate = await tmsDb.$queryRaw<{ active: boolean }[]>`SELECT active FROM damage_reason WHERE id = ${id}::uuid`
      expect(afterActivate[0]!.active).toBe(true)
    } finally {
      await deleteDamageReason(id)
    }
  })
})

describe('ops-edge actions: courier master completion (Phase 3 Task 2, BRD FR-11)', () => {
  // vndr is NOT in this file's beforeEach truncate list (other suites in this
  // file/workspace may depend on it persisting across their own tests), so
  // every row this block creates is deleted BY ID in a `finally`, same
  // discipline as the damage_reason block above.
  async function deleteVendor(idWire: string): Promise<void> {
    await fulfillmentDb.$executeRaw`DELETE FROM vndr WHERE id = ${toUuid(idWire)}::uuid`
  }

  it('POST vendors with courierCode + integrationMode creates the row (200) and emits ONE vendor-create ALLOW 6e', async () => {
    const token = await mint({})
    const courierCode = `crt-${randomUUID().slice(0, 8)}`
    const res = await request(app.getHttpServer())
      .post('/ops/vendors')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'COURIER', displayName: 'Speedy Couriers', courierCode, integrationMode: 'webhook' })
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(false)
    const vndrId = res.body.vndrId as string
    try {
      const rows = await rawAuditRows()
      const match = (rows as { operation: string; decision: string; resourceIds?: string[] }[]).filter(
        (r) => r.operation === 'ops:vendor-create',
      )
      expect(match).toHaveLength(1)
      expect(match[0]!.decision).toBe('ALLOW')
      expect(match[0]!.resourceIds).toEqual([vndrId])

      const dbRow = await fulfillmentDb.$queryRaw<{ courier_code: string | null; integration_mode: string | null }[]>`
        SELECT courier_code, integration_mode FROM vndr WHERE id = ${toUuid(vndrId)}::uuid`
      expect(dbRow[0]!.courier_code).toBe(courierCode)
      expect(dbRow[0]!.integration_mode).toBe('webhook')
    } finally {
      await deleteVendor(vndrId)
    }
  })

  it('POST vendors with a courierCode already taken -> 409/400 (a clean 4xx via OpsClientError, not 500)', async () => {
    const token = await mint({})
    const courierCode = `dup-${randomUUID().slice(0, 8)}`
    const first = await request(app.getHttpServer())
      .post('/ops/vendors')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'COURIER', displayName: 'Speedy Couriers', courierCode })
    const vndrId = first.body.vndrId as string
    try {
      const dupToken = await mint({})
      const res = await request(app.getHttpServer())
        .post('/ops/vendors')
        .set('Authorization', `Bearer ${dupToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ type: 'COURIER', displayName: 'Rival Couriers', courierCode })
      expect(res.status).toBe(400)
    } finally {
      await deleteVendor(vndrId)
    }
  })

  it('POST vendors/:id/edit updates displayName/courierCode/integrationMode (200) and emits ONE vendor-edit ALLOW 6e; an unauthorized role is rejected first', async () => {
    const createToken = await mint({})
    const originalCode = `orig-${randomUUID().slice(0, 8)}`
    const createRes = await request(app.getHttpServer())
      .post('/ops/vendors')
      .set('Authorization', `Bearer ${createToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ type: 'COURIER', displayName: 'Old Name', courierCode: originalCode, integrationMode: 'batch' })
    const vndrId = createRes.body.vndrId as string
    try {
      const unauthToken = await mint({ psr: 'role:not_ops' })
      const deniedRes = await request(app.getHttpServer())
        .post(`/ops/vendors/${vndrId}/edit`)
        .set('Authorization', `Bearer ${unauthToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ displayName: 'Should Not Apply' })
      expect(deniedRes.status).toBe(403)
      const unchanged = await fulfillmentDb.$queryRaw<{ display_name: string }[]>`
        SELECT display_name FROM vndr WHERE id = ${toUuid(vndrId)}::uuid`
      expect(unchanged[0]!.display_name).toBe('Old Name')

      const newCode = `new-${randomUUID().slice(0, 8)}`
      const editToken = await mint({})
      const editRes = await request(app.getHttpServer())
        .post(`/ops/vendors/${vndrId}/edit`)
        .set('Authorization', `Bearer ${editToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ displayName: 'New Name', courierCode: newCode, integrationMode: 'webhook' })
      expect(editRes.status).toBe(200)
      expect(editRes.body.deduped).toBe(false)

      const dbRow = await fulfillmentDb.$queryRaw<
        { display_name: string; courier_code: string | null; integration_mode: string | null }[]
      >`SELECT display_name, courier_code, integration_mode FROM vndr WHERE id = ${toUuid(vndrId)}::uuid`
      expect(dbRow[0]!.display_name).toBe('New Name')
      expect(dbRow[0]!.courier_code).toBe(newCode)
      expect(dbRow[0]!.integration_mode).toBe('webhook')

      const rows = await rawAuditRows()
      // Two 6e rows exist for this operation string (the earlier DENY from
      // the unauthorized attempt above, plus this ALLOW); scope to the ALLOW
      // decision so this assertion is about the successful edit only.
      const match = (rows as { operation: string; decision: string; resourceIds?: string[] }[]).filter(
        (r) => r.operation === 'ops:vendor-edit' && r.decision === 'ALLOW',
      )
      expect(match).toHaveLength(1)
      expect(match[0]!.resourceIds).toEqual([vndrId])
    } finally {
      await deleteVendor(vndrId)
    }
  })

  it('POST vendors/:id/edit on a non-existent vndrId -> 404, not 500', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer())
      .post(`/ops/vendors/${newId('vndr')}/edit`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ displayName: 'Ghost' })
    expect(res.status).toBe(404)
  })
})
