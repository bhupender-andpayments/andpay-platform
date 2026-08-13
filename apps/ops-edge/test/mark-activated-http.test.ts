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
// no bound port. Phase 5 Task 2 (D-H.1): exercises the class-3 ops "mark
// activated" route (POST /ops/assignments/activate) end to end: the DELIVERED
// gate READ (this.deps.analyticsDb, a local projection, no cross-context DB
// read) against a seeded dispatch_row, the TMS write (activateAssignmentOps)
// with the co-committed ALLOW 6e landing in the TMS outbox, and the D2
// authorize DENY (a role lacking ops:mark-activated) landing in the
// fulfillment outbox (emitOpsAuthzAudit's fixed target).
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-mark-activated-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const identityDb = new IdentityClient({
  datasourceUrl: process.env.IDENTITY_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
})

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// Mint a live class-3 internal-admin access token. Defaults to a fresh AAL2
// human claim carrying the ops_portal role (psr `role:ops_portal`, granted
// ops:mark-activated via the shared OPS_PERMISSIONS bundle); a caller
// overrides psr to drive an authz DENY (a role with no ops permissions at all).
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    // A UUID, because the activation trail stores actor_id as a uuid (D-16,
    // T4.1a) exactly like pending_pool_entry.held_by_actor and
    // quarantine_row.resolved_by_actor. In production claim.sub IS a principal
    // uuid; this fixture used to carry a readable label and only got away with
    // it while no writer cast it.
    sub: randomUUID(),
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

interface FulfillmentAuditRow {
  decision: string
  operation: string
  reasonCode: string | undefined
  resourceIds: string[] | undefined
}

async function fulfillmentAuditRows(): Promise<FulfillmentAuditRow[]> {
  const rows = await fulfillmentDb.$queryRaw<
    { payload: { decision: string; operation: string; reasonCode?: string; resourceIds?: string[] } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({
    decision: r.payload.decision,
    operation: r.payload.operation,
    reasonCode: r.payload.reasonCode,
    resourceIds: r.payload.resourceIds,
  }))
}

interface TmsAuditRow {
  decision: string
  operation: string
  resourceIds: string[] | undefined
}

async function tmsAuditRows(): Promise<TmsAuditRow[]> {
  const rows = await tmsDb.$queryRaw<
    { payload: { decision: string; operation: string; resourceIds?: string[] } }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation, resourceIds: r.payload.resourceIds }))
}

async function tmsActivatedFactCount(): Promise<number> {
  const rows = await tmsDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox WHERE event_type = 'fct.tms.assignment.activated.v1'`
  return Number(rows[0]!.n)
}

// Seed a TMS assignment row using the SAME wire id the dispatch_row below
// will carry (dispatch_row.dispatchId IS the asgn_ wire id, per
// services/analytics/src/project.ts). This is the row activateAssignmentOps
// actually writes.
async function seedTmsAssignment(asgnId: string): Promise<void> {
  const asgnUuid = toUuid(asgnId)
  await tmsDb.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', ${'x-' + randomUUID() + '@hdfcbank'}, true, 0, 0,
    true, 'pooled-for-fulfillment', ${'file-' + randomUUID()}, 'SOUNDBOX', now()
  )`
}

// Seed the LOCAL analytics projection row the DELIVERED gate reads. Mirrors
// apps/ops-edge/test/reports-routes.test.ts's insertRow shape (the required
// dispatch_row columns), plus delivery_date set only when `delivered`.
// W-5: an optional dispatchGroup, so the not-activatable gate test below can
// seed a COLLATERAL row without a second helper.
async function seedDispatchRow(dispatchId: string, delivered: boolean, dispatchGroup: string | null = null): Promise<void> {
  const programId = randomUUID()
  await analyticsDb.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, delivery_date, received_at, dispatch_group, updated_at)
    VALUES (${dispatchId}, ${programId}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
            ${delivered ? 'DELIVERED' : 'DISPATCHED'}, true, ${delivered ? new Date() : null}, now(),
            ${dispatchGroup}, now())`
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
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox CASCADE')
  await tmsDb.$executeRawUnsafe('TRUNCATE assignment, outbox, inbox CASCADE')
  await analyticsDb.$executeRawUnsafe('TRUNCATE dispatch_row, outbox, inbox CASCADE')
})

describe('POST /ops/assignments/activate (Phase 5 Task 2, D-H.1)', () => {
  it('a DELIVERED assignment -> 200, activated, the activated fact in the TMS outbox, and the ALLOW 6e in the TMS outbox', async () => {
    const asgnId = newId('asgn')
    await seedTmsAssignment(asgnId)
    await seedDispatchRow(asgnId, true)

    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/assignments/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ dispatchId: asgnId })

    expect(res.status).toBe(200)
    expect(res.body.activated).toBe(true)

    const row = await tmsDb.$queryRaw<{ activated_at: Date | null; demand_state: string }[]>`
      SELECT activated_at, demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')

    expect(await tmsActivatedFactCount()).toBe(1)

    const tmsAudit = await tmsAuditRows()
    expect(tmsAudit).toHaveLength(1)
    expect(tmsAudit[0]!.decision).toBe('ALLOW')
    expect(tmsAudit[0]!.operation).toBe('ops:mark-activated')
    expect(tmsAudit[0]!.resourceIds).toEqual([asgnId])

    // No DENY landed in fulfillment's outbox either (the D2 authorize inside
    // gate() allowed).
    expect(await fulfillmentAuditRows()).toHaveLength(0)
  })

  // THE RE-PIN (D-16, T4.2, 13 Aug 2026). This used to assert a 409 and no
  // effect, which pinned the delivered-gate as a rule. The gate is gone:
  // delivery and activation are independent axes and the CWD routinely confirms
  // before the courier's file lands, so an undelivered soundbox is an ordinary
  // activation rather than a conflict.
  it('an UNDELIVERED soundbox (null delivery_date) -> 200 and a real activation', async () => {
    const asgnId = newId('asgn')
    await seedTmsAssignment(asgnId)
    await seedDispatchRow(asgnId, false)

    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/assignments/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ dispatchId: asgnId })

    expect(res.status).toBe(200)
    expect(res.body.activated).toBe(true)

    const row = await tmsDb.$queryRaw<{ activated_at: Date | null; demand_state: string; activation_status: string | null }[]>`
      SELECT activated_at, demand_state, activation_status FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')
    expect(row[0]!.activation_status).toBe('ACTIVATED')

    expect(await tmsActivatedFactCount()).toBe(1)
    expect(await tmsAuditRows()).toHaveLength(1)
  })

  // W-5: a DELIVERED COLLATERAL group must never activate by hand. Paper's
  // lifecycle ends at DELIVERED; without this gate an operator could still
  // hit the route directly (it is absent from the worklist, not blocked).
  it('a DELIVERED COLLATERAL dispatch -> 409 not-activatable, no activation, no activated fact, no 6e ALLOW', async () => {
    const asgnId = newId('asgn')
    await seedTmsAssignment(asgnId)
    await seedDispatchRow(asgnId, true, 'COLLATERAL')

    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/assignments/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ dispatchId: asgnId })

    expect(res.status).toBe(409)
    expect(res.body.message).toBe('not-activatable')

    const row = await tmsDb.$queryRaw<{ activated_at: Date | null; demand_state: string }[]>`
      SELECT activated_at, demand_state FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.activated_at).toBeNull()
    expect(row[0]!.demand_state).toBe('pooled-for-fulfillment')

    expect(await tmsActivatedFactCount()).toBe(0)
    expect(await tmsAuditRows()).toHaveLength(0)
    expect(await fulfillmentAuditRows()).toHaveLength(0)
  })

  // Still refused, and deliberately: the ONE remaining gate (not COLLATERAL)
  // cannot be evaluated without a projected row, and guessing a dispatch group
  // is how a standee gets activated. Fail closed.
  it('a missing dispatch_row (never projected) -> 409 unknown-dispatch, no writes at all', async () => {
    const asgnId = newId('asgn')
    await seedTmsAssignment(asgnId)
    // Deliberately no seedDispatchRow call.

    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/assignments/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ dispatchId: asgnId })

    expect(res.status).toBe(409)
    expect(res.body.message).toBe('unknown-dispatch')
    expect(await tmsActivatedFactCount()).toBe(0)
    expect(await tmsAuditRows()).toHaveLength(0)
  })

  // T4.1b (D-16): the OTHER activation door. Its own route, its own permission
  // and its own operation string, because "I sent this to the CWD" and "the CWD
  // confirmed it" are different claims.
  describe('POST /ops/assignments/request-activation (T4.1b, D-16)', () => {
    it('stamps REQUEST_SENT_TO_CWD across a send and reports what it could not resolve', async () => {
      const known = newId('asgn')
      await seedTmsAssignment(known)
      const missing = newId('asgn')

      const token = await mint()
      const res = await request(app.getHttpServer())
        .post('/ops/assignments/request-activation')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ dispatchIds: [known, missing] })

      expect(res.status).toBe(200)
      expect(res.body.recorded).toEqual([known])
      expect(res.body.unknown).toEqual([missing])

      const row = await tmsDb.$queryRaw<{ activation_status: string | null; activated_at: Date | null }[]>`
        SELECT activation_status, activated_at FROM assignment WHERE id = ${toUuid(known)}::uuid`
      expect(row[0]!.activation_status).toBe('REQUEST_SENT_TO_CWD')
      // Sending the request is NOT activating it. The old scalar stays untouched.
      expect(row[0]!.activated_at).toBeNull()

      const audit = await tmsAuditRows()
      expect(audit).toHaveLength(1)
      expect(audit[0]!.operation).toBe('ops:request-activation')
      expect(audit[0]!.decision).toBe('ALLOW')
    })

    it('an empty list is a 400 with no writes at all', async () => {
      const token = await mint()
      const res = await request(app.getHttpServer())
        .post('/ops/assignments/request-activation')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ dispatchIds: [] })

      expect(res.status).toBe(400)
      expect(await tmsAuditRows()).toHaveLength(0)
    })

    it('a token whose role lacks the permission -> 403 with a DENY 6e, no domain effect', async () => {
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)

      const token = await mint({ psr: 'role:nothing' })
      const res = await request(app.getHttpServer())
        .post('/ops/assignments/request-activation')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ dispatchIds: [asgnId] })

      expect(res.status).toBe(403)
      const row = await tmsDb.$queryRaw<{ activation_status: string | null }[]>`
        SELECT activation_status FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
      expect(row[0]!.activation_status).toBeNull()
    })
  })

  // D-19 (T5.4): the SERVER-SIDE bulk write, which exists to answer the recorded
  // objection to a Mark-all: a client-side loop failing halfway leaves an
  // operator unable to tell which records went through.
  describe('POST /ops/assignments/activate-bulk (T5.4, D-19)', () => {
    it('marks each row independently and reports a result PER ROW, good and bad together', async () => {
      const good = newId('asgn')
      await seedTmsAssignment(good)
      await seedDispatchRow(good, true)

      const collateral = newId('asgn')
      await seedTmsAssignment(collateral)
      await seedDispatchRow(collateral, true, 'COLLATERAL')

      const missing = newId('asgn')
      await seedTmsAssignment(missing)
      // Deliberately no dispatch_row: nothing to evaluate the one gate against.

      const token = await mint()
      const res = await request(app.getHttpServer())
        .post('/ops/assignments/activate-bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ dispatchIds: [good, collateral, missing] })

      expect(res.status).toBe(200)
      expect(res.body.results).toEqual([
        { dispatchId: good, activated: true, reason: null },
        { dispatchId: collateral, activated: false, reason: 'not-activatable' },
        { dispatchId: missing, activated: false, reason: 'unknown-dispatch' },
      ])

      // The one good row really landed; the two bad ones did not roll it back.
      const row = await tmsDb.$queryRaw<{ activation_status: string | null }[]>`
        SELECT activation_status FROM assignment WHERE id = ${toUuid(good)}::uuid`
      expect(row[0]!.activation_status).toBe('ACTIVATED')
      const untouched = await tmsDb.$queryRaw<{ activated_at: Date | null }[]>`
        SELECT activated_at FROM assignment WHERE id = ${toUuid(collateral)}::uuid`
      expect(untouched[0]!.activated_at).toBeNull()

      // One activated fact and one ALLOW 6e: the rows that never ran emit
      // neither, so the audit never claims work that did not happen.
      expect(await tmsActivatedFactCount()).toBe(1)
      expect(await tmsAuditRows()).toHaveLength(1)
    })

    it('a re-sent batch marks nothing twice, whatever idempotency key it carries', async () => {
      // The underlying write dedups on the BUSINESS key, not the client key, so
      // this holds even for an operator who generated a fresh key.
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)
      await seedDispatchRow(asgnId, true)
      const token = await mint()

      const send = () =>
        request(app.getHttpServer())
          .post('/ops/assignments/activate-bulk')
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({ dispatchIds: [asgnId] })

      const first = await send()
      const second = await send()

      expect(first.body.results[0].activated).toBe(true)
      expect(second.body.results[0]).toEqual({ dispatchId: asgnId, activated: false, reason: 'already-activated' })
      expect(await tmsActivatedFactCount()).toBe(1)
      expect(await tmsAuditRows()).toHaveLength(1)
    })

    it('an empty list is a 400 with no writes at all', async () => {
      const token = await mint()
      const res = await request(app.getHttpServer())
        .post('/ops/assignments/activate-bulk')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ dispatchIds: [] })

      expect(res.status).toBe(400)
      expect(await tmsAuditRows()).toHaveLength(0)
    })

    it('a token whose role lacks ops:mark-activated -> 403, no row touched', async () => {
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)
      await seedDispatchRow(asgnId, true)

      const res = await request(app.getHttpServer())
        .post('/ops/assignments/activate-bulk')
        .set('Authorization', `Bearer ${await mint({ psr: 'role:nothing' })}`)
        .set('Idempotency-Key', randomUUID())
        .send({ dispatchIds: [asgnId] })

      expect(res.status).toBe(403)
      const row = await tmsDb.$queryRaw<{ activated_at: Date | null }[]>`
        SELECT activated_at FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
      expect(row[0]!.activated_at).toBeNull()
      expect(await tmsActivatedFactCount()).toBe(0)
    })
  })

  it('a token whose role lacks ops:mark-activated -> 403 with a DENY 6e, no domain effect', async () => {
    const asgnId = newId('asgn')
    await seedTmsAssignment(asgnId)
    await seedDispatchRow(asgnId, true)

    // support_readonly carries no OPS_ROLES entry at all (ops-config.ts), so
    // the D2 authorize resolves to a deny for every ops: permission.
    const token = await mint({ psr: 'role:support_readonly' })
    const res = await request(app.getHttpServer())
      .post('/ops/assignments/activate')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ dispatchId: asgnId })

    expect(res.status).toBe(403)

    const row = await tmsDb.$queryRaw<{ activated_at: Date | null }[]>`
      SELECT activated_at FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.activated_at).toBeNull()
    expect(await tmsActivatedFactCount()).toBe(0)
    expect(await tmsAuditRows()).toHaveLength(0)

    const fAudit = await fulfillmentAuditRows()
    expect(fAudit).toHaveLength(1)
    expect(fAudit[0]!.decision).toBe('DENY')
    expect(fAudit[0]!.operation).toBe('ops:mark-activated')
  })

  it('without an Idempotency-Key -> 400, no domain effect, no 6e at all', async () => {
    const asgnId = newId('asgn')
    await seedTmsAssignment(asgnId)
    await seedDispatchRow(asgnId, true)

    const token = await mint()
    const res = await request(app.getHttpServer())
      .post('/ops/assignments/activate')
      .set('Authorization', `Bearer ${token}`)
      .send({ dispatchId: asgnId })

    expect(res.status).toBe(400)
    expect(await tmsActivatedFactCount()).toBe(0)
    expect(await tmsAuditRows()).toHaveLength(0)
    expect(await fulfillmentAuditRows()).toHaveLength(0)
  })
})
