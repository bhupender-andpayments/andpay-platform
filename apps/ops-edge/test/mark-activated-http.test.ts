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
  // `unit` joined the list with the T5.5 activation upload: it resolves device
  // serials through unit.asgn_id, and a serial left behind by a previous test
  // would resolve to somebody else's assignment.
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE unit, outbox, inbox CASCADE')
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

    const row = await tmsDb.$queryRaw<{ activated_at: Date | null; demand_state: string; activated_by: string | null }[]>`
      SELECT activated_at, demand_state, activated_by::text AS activated_by FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
    expect(row[0]!.activated_at).not.toBeNull()
    expect(row[0]!.demand_state).toBe('activated')
    expect(row[0]!.activated_by).not.toBeNull()

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

  // The request-activation describe block was DELETED (ACTIVATION.md,
  // 21 Aug 2026) along with the route it covered: there is no
  // REQUEST_SENT_TO_CWD state any more, so there is nothing to stamp.

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
      const row = await tmsDb.$queryRaw<{ activated_by: string | null }[]>`
        SELECT activated_by::text AS activated_by FROM assignment WHERE id = ${toUuid(good)}::uuid`
      expect(row[0]!.activated_by).not.toBeNull()
      const untouched = await tmsDb.$queryRaw<{ activated_at: Date | null }[]>`
        SELECT activated_at FROM assignment WHERE id = ${toUuid(collateral)}::uuid`
      expect(untouched[0]!.activated_at).toBeNull()

      // One activated fact and one ALLOW 6e: the rows that never ran emit
      // neither, so the audit never claims work that did not happen.
      expect(await tmsActivatedFactCount()).toBe(1)
      expect(await tmsAuditRows()).toHaveLength(1)
    })

    it('a re-sent batch marks nothing twice, whatever idempotency key it carries', async () => {
      // Since 23 Aug 2026 the second call is refused by the write's own
      // `activated_at IS NULL` guard, not by a forever business key. The EFFECT
      // is still exactly once (one fact); the second authorized attempt is
      // audited, which is the rule every other ops write already follows.
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
      expect(await tmsAuditRows()).toHaveLength(2)
    })

    // THE REPORTED DEFECT, at the route the portal actually calls (23 Aug
    // 2026). Reported as: "3 devices were displaying, but only 2 got
    // activated", and "clicking one by one from the activation page does not
    // activate, it says 0 devices activated".
    //
    // Both were the same cause. Activation's dedup key was the FOREVER business
    // key `${asgnId}|activate`, so once a dispatch had ever been activated its
    // inbox row swallowed every later attempt, even after a deactivation had
    // set activated_at back to null. Every previously-deactivated row in a
    // selection came back activated:false / already-activated, so a bulk of
    // three reported two, and a single re-activation reported zero.
    it('re-activates rows that were deactivated, so a mixed selection activates ALL of them', async () => {
      // Three delivered soundboxes. Two get activated then deactivated (the
      // toggle an operator has on the device page); the third is untouched.
      const recycled = [newId('asgn'), newId('asgn')]
      const fresh = newId('asgn')
      for (const id of [...recycled, fresh]) {
        await seedTmsAssignment(id)
        await seedDispatchRow(id, true)
      }
      const token = await mint()
      const post = (path: string, body: object) =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send(body)

      for (const id of recycled) {
        expect((await post('/ops/assignments/activate', { dispatchId: id })).body.activated).toBe(true)
        expect((await post('/ops/assignments/deactivate', { dispatchId: id })).body.deactivated).toBe(true)
      }

      // The selection the operator checks in the portal: two recycled, one new.
      const res = await post('/ops/assignments/activate-bulk', { dispatchIds: [...recycled, fresh] })

      expect(res.status).toBe(200)
      // ALL THREE. This is the assertion that failed: the two recycled rows
      // came back { activated: false, reason: 'already-activated' }.
      expect(res.body.results).toEqual([
        { dispatchId: recycled[0], activated: true, reason: null },
        { dispatchId: recycled[1], activated: true, reason: null },
        { dispatchId: fresh, activated: true, reason: null },
      ])

      // And the rows really are live again in TMS, not merely reported so.
      for (const id of [...recycled, fresh]) {
        const row = await tmsDb.$queryRaw<{ activated_at: Date | null }[]>`
          SELECT activated_at FROM assignment WHERE id = ${toUuid(id)}::uuid`
        expect(row[0]!.activated_at).not.toBeNull()
      }

      // FIVE activation facts, all with distinct dedup keys: two first-time,
      // two re-activations, one fresh. The distinctness is what lets
      // fulfillment's projector re-stamp unit.activated_at, so the batch's
      // device page agrees with the Activation tab instead of showing a device
      // as not-activated forever.
      const facts = await tmsDb.$queryRaw<{ payload: { dedupKey: string } }[]>`
        SELECT payload FROM outbox WHERE event_type = 'fct.tms.assignment.activated.v1'`
      expect(facts).toHaveLength(5)
      expect(new Set(facts.map((f) => f.payload.dedupKey)).size).toBe(5)
    })

    // The single-dispatch route is what the inner batch page uses per row, and
    // it went through the same door, so it gets its own guard.
    it('the single activate route re-activates a deactivated dispatch', async () => {
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)
      await seedDispatchRow(asgnId, true)
      const token = await mint()
      const post = (path: string) =>
        request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', randomUUID())
          .send({ dispatchId: asgnId })

      expect((await post('/ops/assignments/activate')).body.activated).toBe(true)
      expect((await post('/ops/assignments/deactivate')).body.deactivated).toBe(true)
      // Was false ("0 devices activated" in the portal). Must be a real flip.
      expect((await post('/ops/assignments/activate')).body.activated).toBe(true)
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

    // D-19 (T5.5): the CWD's activation file. It names DEVICES; the platform
  // activates ASSIGNMENTS, so the edge resolves the serial through
  // fulfillment's unit.asgn_id and then runs the same per-row activation.
  describe('POST /ops/uploads/activation (T5.5, D-19)', () => {
    async function seedUnitFor(asgnId: string, serial: string): Promise<void> {
      await fulfillmentDb.$executeRaw`
        INSERT INTO unit (id, kind, product_type, manufacturer_vndr, status, device_serial, asgn_id, updated_at)
        VALUES (${toUuid(newId('unit'))}::uuid, 'SERIALIZED', 'SOUNDBOX', ${toUuid(newId('vndr'))}::uuid,
                'DELIVERED', ${serial}, ${toUuid(asgnId)}::uuid, now())
      `
    }

    function csv(lines: string[]): Buffer {
      return Buffer.from(lines.join('\n') + '\n', 'utf8')
    }

    it('activates by DEVICE serial, resolving each one back to its dispatch', async () => {
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)
      await seedDispatchRow(asgnId, true)
      await seedUnitFor(asgnId, 'SER-ACT-1')

      const res = await request(app.getHttpServer())
        .post('/ops/uploads/activation')
        .set('Authorization', `Bearer ${await mint()}`)
        .set('Idempotency-Key', randomUUID())
        .attach('file', csv(['Device ID,Status', 'SER-ACT-1,Activated']), 'cwd.csv')

      expect(res.status).toBe(200)
      expect(res.body.activated).toBe(1)
      expect(res.body.results[0]).toEqual({
        deviceId: 'SER-ACT-1',
        dispatchId: asgnId,
        activated: true,
        reason: null,
      })

      const row = await tmsDb.$queryRaw<{ activated_by: string | null }[]>`
        SELECT activated_by::text AS activated_by FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
      expect(row[0]!.activated_by).not.toBeNull()
    })

    it('a serial the platform cannot place is REPORTED, never dropped', async () => {
      const res = await request(app.getHttpServer())
        .post('/ops/uploads/activation')
        .set('Authorization', `Bearer ${await mint()}`)
        .set('Idempotency-Key', randomUUID())
        .attach('file', csv(['Device ID,Status', 'SER-NOBODY,Activated']), 'cwd.csv')

      expect(res.status).toBe(200)
      expect(res.body.activated).toBe(0)
      expect(res.body.results).toEqual([
        { deviceId: 'SER-NOBODY', dispatchId: '', activated: false, reason: 'unknown-device' },
      ])
    })

    it('a row claiming a FAILURE is rejected by name, because no failure write exists (C3 fence)', async () => {
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)
      await seedDispatchRow(asgnId, true)
      await seedUnitFor(asgnId, 'SER-ACT-2')

      const res = await request(app.getHttpServer())
        .post('/ops/uploads/activation')
        .set('Authorization', `Bearer ${await mint()}`)
        .set('Idempotency-Key', randomUUID())
        .attach('file', csv(['Device ID,Status', 'SER-ACT-2,Failed']), 'cwd.csv')

      expect(res.status).toBe(200)
      expect(res.body.activated).toBe(0)
      expect(res.body.invalid).toBe(1)
      expect(res.body.invalidRows[0].errors).toEqual(['unsupported_status'])
      // Nothing was written for that device.
      const row = await tmsDb.$queryRaw<{ activated_at: Date | null }[]>`
        SELECT activated_at FROM assignment WHERE id = ${toUuid(asgnId)}::uuid`
      expect(row[0]!.activated_at).toBeNull()
    })

    it('a missing required COLUMN is a 400 naming the column and never the filename (S4/5c)', async () => {
      const res = await request(app.getHttpServer())
        .post('/ops/uploads/activation')
        .set('Authorization', `Bearer ${await mint()}`)
        .set('Idempotency-Key', randomUUID())
        .attach('file', csv(['Device ID', 'SER-ACT-3']), 'private-notes.csv')

      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).toContain('Status')
      expect(JSON.stringify(res.body)).not.toContain('private-notes')
    })

    it('a token whose role lacks ops:mark-activated -> 403, nothing activated', async () => {
      const asgnId = newId('asgn')
      await seedTmsAssignment(asgnId)
      await seedDispatchRow(asgnId, true)
      await seedUnitFor(asgnId, 'SER-ACT-4')

      const res = await request(app.getHttpServer())
        .post('/ops/uploads/activation')
        .set('Authorization', `Bearer ${await mint({ psr: 'role:nothing' })}`)
        .set('Idempotency-Key', randomUUID())
        .attach('file', csv(['Device ID,Status', 'SER-ACT-4,Activated']), 'cwd.csv')

      expect(res.status).toBe(403)
      expect(await tmsActivatedFactCount()).toBe(0)
    })
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
