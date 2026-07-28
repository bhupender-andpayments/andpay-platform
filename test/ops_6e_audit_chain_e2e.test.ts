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
import { PrismaClient as FulfillmentClient, loadOpsConfig } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '@andpay/ops-edge'

// Root-only integration seam (mirrors test/tenant_read_audit_chain_e2e.test.ts's
// 10b precedent exactly): proves the FULL Task-9/Task-10 path end to end for a
// class-3 ops MUTATION -- a REAL decision, driven over HTTP through the ops
// edge, lands in fulfillment's outbox as an authz.audit row, and Auth's
// UNCHANGED 10a consumer (consumeAuthzAudit) appends it to the tamper-evident
// hash-chain, with verifyAuthzChain reporting ok and a redelivery of the same
// payload.id a strict no-op (E6 dedup). This reuses consumeAuthzAudit and
// verifyAuthzChain verbatim: a class-3 human-direct ops record chains through
// the exact same appender as every other class, with zero new consumer wiring.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-chain-e2e-key-1'

const authUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'

const authDb = new AuthClient({ datasourceUrl: authUrl })
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })

let app: INestApplication
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// The free-text override reason, asserted present NOWHERE in the emitted 6e
// records: the override entry is IDs-and-enums only (S7/S10.5, DD1), even
// though the underlying domain row genuinely stores this free text.
const OVERRIDE_REASON = 'lost in transit, reissued manually after courier confirmed damage'

interface Seeded {
  shptId: string
}

async function seedShpt(status: string): Promise<Seeded> {
  const shptId = randomUUID()
  const tenantId = randomUUID()
  const programId = randomUUID()
  await fulfillmentDb.$executeRaw`
    INSERT INTO shpt (id, awb, courier_partner, status, dispatch_date, tenant_id, program_id, updated_at)
    VALUES (${shptId}::uuid, ${'AWB-' + shptId.slice(0, 8)}, NULL, ${status}, now(), ${tenantId}::uuid, ${programId}::uuid, now())
  `
  return { shptId }
}

let seeded: Seeded

// Mint a live class-3 internal-admin access token (mirrors
// apps/ops-edge/test/ops-actions-http.test.ts's precedent). Defaults to a
// FRESH AAL2 human claim carrying the ops_portal role; a caller overrides
// acr/auth_time to drive the step-up-required DENY instead.
async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_6e_e2e',
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
  await authDb.$disconnect()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
})

beforeEach(async () => {
  // The chain and its own E6 inbox rows: the chain must start empty (seq from
  // 1, prev from GENESIS) for every test in this file.
  await authDb.$executeRaw`DELETE FROM authz_audit`
  await authDb.$executeRawUnsafe(`DELETE FROM inbox WHERE consumer = '${AUTHZ_AUDIT_CONSUMER}'`)
  // The fulfillment outbox/inbox this test reads the delivered payload from,
  // and the shpt row the mutation is authorized over.
  await fulfillmentDb.$executeRawUnsafe(
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, pending_pool_entry, composed_artifact, outbox, inbox CASCADE',
  )
  seeded = await seedShpt('IN_TRANSIT')
})

describe('6e authz-audit chain e2e for ops mutation decisions (task 10, LOAD-BEARING)', () => {
  it('a real terminal-OVERRIDE ALLOW and a real step-up-required DENY chain via the UNCHANGED 10a consumer, verify ok, and dedup on redelivery', async () => {
    // (a) a REAL successful mutation over HTTP: a live class-3 internal-admin
    // token, FRESH AAL2 (auth_time now) -> clears the per-action step-up gate
    // for ops:terminal-override -> 200. The controller's audit-AFTER-success
    // step emits ONE terminal-override ALLOW 6e (Task 9), carrying the enum
    // reasonCode plus the step-up assurance (acr, authTime) that authorized
    // the C3 bypass, and the target resource id.
    const allowToken = await mint({})
    const allowRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${seeded.shptId}/override`)
      .set('Authorization', `Bearer ${allowToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: OVERRIDE_REASON })
    expect(allowRes.status).toBe(200)
    expect(allowRes.body.overridden).toBe(true)
    // Sanity: the mutation genuinely took effect (the raw C3 bypass), so the
    // "no free text in the audit record" assertion below is meaningful rather
    // than vacuous.
    const shptAfter = await fulfillmentDb.$queryRaw<{ status: string }[]>`
      SELECT status FROM shpt WHERE id = ${seeded.shptId}::uuid
    `
    expect(shptAfter[0]!.status).toBe('DELIVERED')

    // (b) a REAL step-up-required DENY over HTTP: the SAME action
    // (ops:terminal-override) with a STALE auth_time (below the 300s
    // freshness window) -> 403 before any domain op runs. The controller's
    // gate() step emits ONE step-up-required DENY 6e.
    const now = Math.floor(Date.now() / 1000)
    const denyToken = await mint({ auth_time: now - 1000 })
    const denyRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/override`)
      .set('Authorization', `Bearer ${denyToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: OVERRIDE_REASON })
    expect(denyRes.status).toBe(403)

    // Read BOTH delivered payloads from the fulfillment outbox: the actual
    // persisted rows, not a re-minted fixture.
    const rows = await readAuditOutbox()
    expect(rows).toHaveLength(2)
    const allowPayload = rows[0]!.payload
    const denyPayload = rows[1]!.payload

    // IDs-and-enums only (S7/S10.5, DD1): the free-text override reason lives
    // ONLY on shpt_status_event.override_reason, never the 6e record, even
    // though the underlying domain row genuinely stores it.
    const raw = JSON.stringify(rows.map((r) => r.payload))
    expect(raw).not.toContain(OVERRIDE_REASON)
    expect(raw).not.toContain('lost in transit')

    // CRITICAL override ALLOW assertions: enum reasonCode, step-up assurance
    // (acr, authTime), and the target resource id -- IDs and enums only.
    expect(allowPayload.decision).toBe('ALLOW')
    expect(allowPayload.operation).toBe('ops:terminal-override')
    expect(allowPayload.reasonCode).toBe('terminal-override')
    expect(allowPayload.acr).toBe('AAL2')
    expect(typeof allowPayload.authTime).toBe('number')
    expect(allowPayload.resourceIds).toContain(seeded.shptId)
    expect(allowPayload.cls).toBe(3)
    expect(allowPayload.principalId).toBe('user_ops_6e_e2e')
    expect(allowPayload.actorChannel).toBe('human-direct')

    // DENY shape assertions.
    expect(denyPayload.decision).toBe('DENY')
    expect(denyPayload.reasonCode).toBe('step-up-required')
    expect(denyPayload.operation).toBe('ops:terminal-override')
    expect(denyPayload.cls).toBe(3)
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
