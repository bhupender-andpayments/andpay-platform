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
// no bound port (the ops-actions-http suite's boot shape). DAMAGE_PLAN B5
// (D-26/D-27/D-28): POST /ops/records/:asgnId/flag-damage end to end: the 201
// child mint with its co-committed ALLOW 6e in the TMS outbox, the pre-gate
// body validation 400s (no 6e at all), the domain's not-found 404 and DP-3
// conflict 409 through the app-wide OpsErrorFilter, and the DP-4 replay (the
// same Idempotency-Key returns the SAME child).
//
// The reason code fixture is 'battery_issue', one of the four migration-seeded
// damage_reason master rows (20260804163403), which the global teardown
// preserves as master data, so this suite never creates or deletes master rows.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-flag-damage-test-key-1'

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

// Mint a live class-3 internal-admin access token. A UUID sub, because
// assignment.flagged_by records the actor (D-27) exactly as the activation
// trail and triggered_by_actor record theirs, and in production claim.sub IS a
// principal uuid.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
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

async function tmsAuditRows(): Promise<{ decision: string; operation: string }[]> {
  const rows = await tmsDb.$queryRaw<{ payload: { decision: string; operation: string } }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => ({ decision: r.payload.decision, operation: r.payload.operation }))
}

async function rawTmsAuditRows(): Promise<unknown[]> {
  const rows = await tmsDb.$queryRaw<{ payload: unknown }[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => r.payload)
}

async function fulfillmentAuditCount(): Promise<number> {
  const rows = await fulfillmentDb.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM outbox WHERE event_type = 'authz.audit'`
  return Number(rows[0]!.n)
}

// Seed ONE dispatched leg the operator can flag: a W-5 single-group assignment
// row (the post-split shape flagDamageOps matches on). SOUNDBOX legs carry
// soundbox=true and zero counts; COLLATERAL legs carry the counts.
async function seedLeg(group: 'SOUNDBOX' | 'COLLATERAL'): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  const soundbox = group === 'SOUNDBOX'
  await tmsDb.$executeRaw`INSERT INTO assignment (
    id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc,
    bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count,
    billable, demand_state, source_event_id, dispatch_group, updated_at
  ) VALUES (
    ${asgnUuid}::uuid, ${toUuid(newId('mrch'))}::uuid, ${toUuid(newId('prog'))}::uuid, ${toUuid(newId('tnnt'))}::uuid,
    'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'Addr', 'upi://x', ${'x-' + randomUUID() + '@hdfcbank'},
    ${soundbox}, ${soundbox ? 0 : 1}, ${soundbox ? 0 : 2},
    true, 'pooled-for-fulfillment', ${'file-' + randomUUID()}, ${group}, now()
  )`
  return { asgnWire, asgnUuid }
}

interface ChildRow {
  id: string
  replacement_of: string | null
  case_status: string | null
  billable: boolean
  damage_reason: string | null
  ops_remarks: string | null
  flagged_by: string | null
  dispatch_group: string | null
}

async function childrenOf(parentUuid: string): Promise<ChildRow[]> {
  return tmsDb.$queryRaw<ChildRow[]>`
    SELECT id::text AS id, replacement_of::text AS replacement_of, case_status, billable,
           damage_reason, ops_remarks, flagged_by, dispatch_group
    FROM assignment WHERE replacement_of = ${parentUuid}::uuid`
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
  await tmsDb.$executeRawUnsafe('TRUNCATE assignment, outbox, inbox CASCADE')
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox, inbox CASCADE')
})

describe('POST /ops/records/:asgnId/flag-damage (DAMAGE_PLAN B5)', () => {
  it('201 on a SOUNDBOX leg: mints the Open non-billable child, records the actor, co-commits ONE ALLOW 6e in the TMS outbox', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('SOUNDBOX')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'battery_issue', remarks: 'speaker crackles on every payment' })

    expect(res.status).toBe(201)
    expect(res.body.caseStatus).toBe('Open')
    expect(typeof res.body.childAsgnId).toBe('string')
    expect(res.body.childAsgnId.startsWith('asgn_')).toBe(true)

    const children = await childrenOf(asgnUuid)
    expect(children).toHaveLength(1)
    expect(children[0]!.id).toBe(toUuid(res.body.childAsgnId))
    expect(children[0]!.case_status).toBe('Open')
    expect(children[0]!.billable).toBe(false)
    expect(children[0]!.damage_reason).toBe('battery_issue')
    expect(children[0]!.ops_remarks).toBe('speaker crackles on every payment')
    expect(children[0]!.flagged_by).not.toBeNull()
    // DP-2: the child inherits the flagged leg's group.
    expect(children[0]!.dispatch_group).toBe('SOUNDBOX')

    // The co-committed ALLOW 6e lands in the TMS outbox (C4). The free-text
    // remarks live ONLY on the domain row, never on the IDs-only 6e (DD1).
    const audit = await tmsAuditRows()
    const allow = audit.filter((r) => r.operation === 'ops:flag-damage')
    expect(allow).toEqual([{ decision: 'ALLOW', operation: 'ops:flag-damage' }])
    expect(JSON.stringify(await rawTmsAuditRows())).not.toContain('speaker crackles')
  })

  it('201 on a COLLATERAL leg with operator counts (total >= 1, DP-2)', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('COLLATERAL')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'physical_damage', remarks: 'standee torn in transit', standeeCount: 1, stickerCount: 0 })

    expect(res.status).toBe(201)
    expect(res.body.caseStatus).toBe('Open')
    const children = await childrenOf(asgnUuid)
    expect(children).toHaveLength(1)
    expect(children[0]!.dispatch_group).toBe('COLLATERAL')
  })

  it('missing Idempotency-Key -> 400, no child, no 6e in either outbox', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('SOUNDBOX')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reasonCode: 'battery_issue', remarks: 'no sound at all' })

    expect(res.status).toBe(400)
    expect(await childrenOf(asgnUuid)).toHaveLength(0)
    expect(await tmsAuditRows()).toHaveLength(0)
    expect(await fulfillmentAuditCount()).toBe(0)
  })

  it('blank remarks -> 400 BEFORE the gate: no child and no 6e at all (ALLOW or DENY)', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('SOUNDBOX')
    const token = await mint()
    for (const body of [
      { reasonCode: 'battery_issue' },
      { reasonCode: 'battery_issue', remarks: '' },
      { reasonCode: 'battery_issue', remarks: '   ' },
      { reasonCode: 'battery_issue', remarks: 'x'.repeat(501) },
      { remarks: 'a real remark but no reason code' },
    ]) {
      const res = await request(app.getHttpServer())
        .post(`/ops/records/${asgnWire}/flag-damage`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send(body)
      expect(res.status).toBe(400)
    }
    expect(await childrenOf(asgnUuid)).toHaveLength(0)
    expect(await tmsAuditRows()).toHaveLength(0)
    expect(await fulfillmentAuditCount()).toBe(0)
  })

  it('counts on a SOUNDBOX leg -> 400 (the service contract: a soundbox quantity is fixed at 1, D-27/D-6), no child', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('SOUNDBOX')
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'battery_issue', remarks: 'device dead on arrival', standeeCount: 1, stickerCount: 1 })

    expect(res.status).toBe(400)
    expect(await childrenOf(asgnUuid)).toHaveLength(0)
  })

  it('an unknown asgn -> 404 via the OpsErrorFilter, not 500', async () => {
    const token = await mint()
    const res = await request(app.getHttpServer())
      .post(`/ops/records/${newId('asgn')}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'battery_issue', remarks: 'never seeded' })
    expect(res.status).toBe(404)
  })

  it('a second flag while the first case is still live -> 409 (DP-3: one live case per dispatch), no second child', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('SOUNDBOX')
    const token = await mint()
    const first = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'battery_issue', remarks: 'speaker crackles' })
    expect(first.status).toBe(201)

    const second = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ reasonCode: 'physical_damage', remarks: 'also cracked, flagged twice' })
    expect(second.status).toBe(409)
    expect(await childrenOf(asgnUuid)).toHaveLength(1)
  })

  it('a replay with the SAME Idempotency-Key returns the SAME childAsgnId and mints nothing new (DP-4)', async () => {
    const { asgnWire, asgnUuid } = await seedLeg('SOUNDBOX')
    const token = await mint()
    const key = randomUUID()
    const body = { reasonCode: 'battery_issue', remarks: 'speaker crackles' }

    const first = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
    expect(first.status).toBe(201)

    const replay = await request(app.getHttpServer())
      .post(`/ops/records/${asgnWire}/flag-damage`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(body)
    expect(replay.status).toBe(201)
    expect(replay.body.childAsgnId).toBe(first.body.childAsgnId)
    expect(await childrenOf(asgnUuid)).toHaveLength(1)
  })
})
