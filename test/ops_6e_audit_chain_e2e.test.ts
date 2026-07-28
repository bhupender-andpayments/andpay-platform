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
import {
  PrismaClient as FulfillmentClient,
  loadOpsConfig,
  overrideTerminal,
} from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient, uploadBankFile, type BankRequestRow } from '@andpay/tms-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '@andpay/ops-edge'

// Root-only integration seam (mirrors test/tenant_read_audit_chain_e2e.test.ts's
// 10b precedent): proves the FULL Task-9/Task-10 path AND the spec-10c CC-1
// co-commit correction (S15) end to end. The ALLOW 6e for a sensitive ops
// operation is now enqueued INSIDE the domain transaction (co-commit), into the
// context's OWN authz.audit outbox (fulfillment for a fulfillment action, tms
// for a tms action); the DENYs (no domain tx) stay edge-emitted but DURABLY
// (own committed tx, never swallowed). Auth's UNCHANGED 10a appender
// (consumeAuthzAudit) drains BOTH context outboxes into the ONE tamper-evident
// chain, deduping on payload.id, with verifyAuthzChain reporting ok.
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

// A thrown marker used to force a GENUINE transaction abort in the co-commit
// proof: a Prisma `$extends` query hook throws exactly when the domain op tries
// to enqueue its authz.audit row, so the WHOLE domain transaction (effect +
// co-committed 6e) rolls back. This DISCRIMINATES co-commit from the old
// separate-tx pattern: under co-commit a failed 6e write rolls the effect back
// too (effect count 0); under a separate edge-emit the effect would already
// have committed (effect count 1) while only the later 6e write failed.
class CoCommitAbort extends Error {}

// True when a raw query is the domain op's OWN authz.audit outbox INSERT
// (the 'authz.audit' event_type value rides the raw query args), leaving every
// other statement to run normally so the effect genuinely executes before the
// abort. Concrete per-client builders below apply it (a union-typed generic
// `$extends` call is not callable, so each client is extended directly).
function isAuthzAuditRaw(operation: string, args: unknown): boolean {
  const isRaw =
    operation === '$executeRaw' ||
    operation === '$queryRaw' ||
    operation === '$executeRawUnsafe' ||
    operation === '$queryRawUnsafe'
  return isRaw && JSON.stringify(args).includes('authz.audit')
}

function abortingFulfillment(): FulfillmentClient {
  return fulfillmentDb.$extends({
    query: {
      $allOperations({ operation, args, query }) {
        if (isAuthzAuditRaw(operation, args)) throw new CoCommitAbort('inject: fail the authz.audit enqueue')
        return query(args)
      },
    },
  }) as unknown as FulfillmentClient
}

function abortingTms(): TmsClient {
  return tmsDb.$extends({
    query: {
      $allOperations({ operation, args, query }) {
        if (isAuthzAuditRaw(operation, args)) throw new CoCommitAbort('inject: fail the authz.audit enqueue')
        return query(args)
      },
    },
  }) as unknown as TmsClient
}

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

// A structurally valid bank request row (mirrors services/tms/test/ops.test.ts's
// validRow) so uploadBankFile posts a real pending_row.
function validBankRow(rowNo: number): BankRequestRow {
  return {
    fileId: 'file-e2e',
    rowNo,
    bankMerchantReference: `BM-${rowNo}`,
    displayName: 'Acme',
    legalName: 'Acme Pvt Ltd',
    mcc: '5814',
    registeredAddress: '221B Baker Street',
    bankReferenceCode: 'HDFC',
    productType: 'soundbox',
    vpaValue: 'acme@hdfcbank',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    shipToAddress: '221B Baker Street',
    contactName: 'Jane Doe',
    mobile: '+91-9000000000',
    vpaHint: 'acme@hdfcbank',
  }
}

// Mint a live class-3 internal-admin access token. Defaults to a FRESH AAL2
// human claim carrying the ops_portal role; a caller overrides acr/auth_time to
// drive the step-up-required DENY instead.
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

type AuditPayload = { id: string } & AuthzAuditRecord
type AuditOutboxRow = { payload: AuditPayload }

async function readFulfillmentAudit(): Promise<AuditPayload[]> {
  const rows = await fulfillmentDb.$queryRaw<AuditOutboxRow[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.map((r) => r.payload)
}

async function readTmsAudit(): Promise<AuditPayload[]> {
  const rows = await tmsDb.$queryRaw<AuditOutboxRow[]>`
    SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC
  `
  return rows.map((r) => r.payload)
}

async function shptStatus(shptId: string): Promise<string> {
  const rows = await fulfillmentDb.$queryRaw<{ status: string }[]>`
    SELECT status FROM shpt WHERE id = ${shptId}::uuid
  `
  return rows[0]!.status
}

async function pendingRowCount(): Promise<number> {
  const rows = await tmsDb.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pending_row`
  return Number(rows[0]!.n)
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
    'TRUNCATE shpt_status_event, courier_status_exception, shpt, pending_pool_entry, composed_artifact, vndr, outbox, inbox CASCADE',
  )
  // The tms outbox/inbox and the ingest ledger the tms ops actions co-commit into.
  await tmsDb.$executeRawUnsafe(
    'TRUNCATE assignment, pending_row, merchant_projection, tenant_projection, ingest_file, quarantine_row, outbox, inbox',
  )
  seeded = await seedShpt('IN_TRANSIT')
})

describe('6e authz-audit chain e2e for ops mutation decisions (task 10 + CC-1, LOAD-BEARING)', () => {
  it('a real terminal-OVERRIDE ALLOW (co-committed) and a real step-up-required DENY (durable) chain via the UNCHANGED 10a consumer, verify ok, and dedup on redelivery', async () => {
    // (a) a REAL successful mutation over HTTP: a live class-3 internal-admin
    // token, FRESH AAL2 -> clears the per-action step-up gate for
    // ops:terminal-override -> 200. The DOMAIN op now co-commits ONE
    // terminal-override ALLOW 6e INSIDE its transaction (CC-1), carrying the
    // enum reasonCode plus the step-up assurance (acr, authTime), and the
    // target id.
    const allowToken = await mint({})
    const allowRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${seeded.shptId}/override`)
      .set('Authorization', `Bearer ${allowToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: OVERRIDE_REASON })
    expect(allowRes.status).toBe(200)
    expect(allowRes.body.overridden).toBe(true)
    // Sanity: the mutation genuinely took effect (the raw C3 bypass).
    expect(await shptStatus(seeded.shptId)).toBe('DELIVERED')

    // (b) a REAL step-up-required DENY over HTTP: the SAME action with a STALE
    // auth_time -> 403 before any domain op runs. The edge emits ONE
    // step-up-required DENY 6e DURABLY (own committed tx).
    const now = Math.floor(Date.now() / 1000)
    const denyToken = await mint({ auth_time: now - 1000 })
    const denyRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/override`)
      .set('Authorization', `Bearer ${denyToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: OVERRIDE_REASON })
    expect(denyRes.status).toBe(403)

    // Both records land in fulfillment's authz.audit outbox: the ALLOW
    // co-committed by the domain op, the DENY durably by the edge.
    const rows = await readFulfillmentAudit()
    expect(rows).toHaveLength(2)
    const allowPayload = rows[0]!
    const denyPayload = rows[1]!

    // IDs-and-enums only (S7/S10.5, DD1): the free-text override reason lives
    // ONLY on shpt_status_event.override_reason, never the 6e record.
    const raw = JSON.stringify(rows)
    expect(raw).not.toContain(OVERRIDE_REASON)
    expect(raw).not.toContain('lost in transit')

    expect(allowPayload.decision).toBe('ALLOW')
    expect(allowPayload.operation).toBe('ops:terminal-override')
    expect(allowPayload.reasonCode).toBe('terminal-override')
    expect(allowPayload.acr).toBe('AAL2')
    expect(typeof allowPayload.authTime).toBe('number')
    expect(allowPayload.resourceIds).toContain(seeded.shptId)
    expect(allowPayload.cls).toBe(3)
    expect(allowPayload.principalId).toBe('user_ops_6e_e2e')
    expect(allowPayload.actorChannel).toBe('human-direct')

    expect(denyPayload.decision).toBe('DENY')
    expect(denyPayload.reasonCode).toBe('step-up-required')
    expect(denyPayload.operation).toBe('ops:terminal-override')
    expect(denyPayload.cls).toBe(3)
    expect(denyPayload.actorChannel).toBe('human-direct')

    const before = await verifyAuthzChain(authDb)
    expect(before).toEqual({ ok: true, length: 0 })

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

    // Redelivery of the SAME allowPayload.id is a strict no-op (E6 dedup).
    const redelivered = await consumeAuthzAudit(authDb, allowPayload)
    expect(redelivered).toEqual({ appended: false })
    const countAfter = await authDb.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM authz_audit`
    expect(Number(countAfter[0]!.n)).toBe(2)
    expect(await verifyAuthzChain(authDb)).toEqual({ ok: true, length: 2 })
  })

  it('a fulfillment ALLOW and a TMS ALLOW are drained from their RESPECTIVE outboxes and chained by the ONE UNCHANGED consumer (CC-1 part D)', async () => {
    const token = await mint({})

    // A fulfillment ops action (correct advances the ladder) -> ALLOW
    // co-committed to FULFILLMENT's outbox.
    const correctRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${seeded.shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'OUT_FOR_DELIVERY', courierTimestamp: '2026-07-27T11:00:00Z' })
    expect(correctRes.status).toBe(200)
    expect(await shptStatus(seeded.shptId)).toBe('OUT_FOR_DELIVERY')

    // A tms ops action (bank-file upload) -> ALLOW co-committed to TMS's OWN
    // outbox (no cross-schema write, C4).
    const uploadRes = await request(app.getHttpServer())
      .post('/ops/uploads/bank')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ rows: [validBankRow(1)] })
    expect(uploadRes.status).toBe(200)
    expect(uploadRes.body.accepted).toBe(1)

    const fulfillmentAudit = await readFulfillmentAudit()
    const tmsAudit = await readTmsAudit()
    expect(fulfillmentAudit).toHaveLength(1)
    expect(tmsAudit).toHaveLength(1)

    const fAllow = fulfillmentAudit[0]!
    const tAllow = tmsAudit[0]!
    expect(fAllow.decision).toBe('ALLOW')
    expect(fAllow.operation).toBe('ops:status-correction')
    expect(fAllow.resourceIds).toContain(seeded.shptId)
    expect(tAllow.decision).toBe('ALLOW')
    expect(tAllow.operation).toBe('ops:upload-bank-file')
    expect(tAllow.cls).toBe(3)
    expect(tAllow.actorChannel).toBe('human-direct')

    // Both drain into the ONE ordered chain via the UNCHANGED appender.
    expect(await verifyAuthzChain(authDb)).toEqual({ ok: true, length: 0 })
    expect(await consumeAuthzAudit(authDb, fAllow)).toEqual({ appended: true, seq: 1 })
    expect(await consumeAuthzAudit(authDb, tAllow)).toEqual({ appended: true, seq: 2 })
    expect(await verifyAuthzChain(authDb)).toEqual({ ok: true, length: 2 })

    // Re-consuming the tms id is a strict no-op (dedup on payload.id).
    expect(await consumeAuthzAudit(authDb, tAllow)).toEqual({ appended: false })
    expect(await verifyAuthzChain(authDb)).toEqual({ ok: true, length: 2 })
  })

  it('CO-COMMIT: a rolled-back domain tx leaves NEITHER the effect NOR the 6e; a commit leaves exactly ONE of each (fulfillment + tms)', async () => {
    // --- Fulfillment: overrideTerminal. Abort the tx at the authz.audit
    // enqueue and prove the raw C3-bypass UPDATE is ALSO rolled back. ---
    const abortShpt = (await seedShpt('IN_TRANSIT')).shptId
    await expect(
      overrideTerminal(abortingFulfillment(), {
        shptId: abortShpt,
        status: 'DELIVERED',
        courierTimestamp: new Date('2026-07-27T10:00:00Z'),
        overrideReason: OVERRIDE_REASON,
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-abort-f',
        acr: 'AAL2',
        authTime: 1,
      }),
    ).rejects.toBeInstanceOf(CoCommitAbort)
    // DISCRIMINATOR: under co-commit the effect is gone (still IN_TRANSIT); a
    // separate-tx emit would have left it DELIVERED. And no 6e row exists.
    expect(await shptStatus(abortShpt)).toBe('IN_TRANSIT')
    expect(await readFulfillmentAudit()).toHaveLength(0)

    // A clean commit: effect applied AND exactly one co-committed 6e.
    const commitShpt = (await seedShpt('IN_TRANSIT')).shptId
    await overrideTerminal(fulfillmentDb, {
      shptId: commitShpt,
      status: 'DELIVERED',
      courierTimestamp: new Date('2026-07-27T10:00:00Z'),
      overrideReason: OVERRIDE_REASON,
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-commit-f',
      acr: 'AAL2',
      authTime: 1,
    })
    expect(await shptStatus(commitShpt)).toBe('DELIVERED')
    const fAfter = await readFulfillmentAudit()
    expect(fAfter).toHaveLength(1)
    expect(fAfter[0]!.operation).toBe('ops:terminal-override')

    // --- TMS: uploadBankFile. Abort at the authz.audit enqueue and prove the
    // pending_row ingest is ALSO rolled back (co-commit into the TMS outbox). ---
    await expect(
      uploadBankFile(abortingTms(), {
        rows: [validBankRow(1)],
        clientKey: randomUUID(),
        actorId: randomUUID(),
        traceId: 't-abort-t',
      }),
    ).rejects.toBeInstanceOf(CoCommitAbort)
    expect(await pendingRowCount()).toBe(0)
    expect(await readTmsAudit()).toHaveLength(0)

    // A clean commit: one pending_row AND exactly one co-committed 6e.
    await uploadBankFile(tmsDb, {
      rows: [validBankRow(1)],
      clientKey: randomUUID(),
      actorId: randomUUID(),
      traceId: 't-commit-t',
    })
    expect(await pendingRowCount()).toBe(1)
    const tAfter = await readTmsAudit()
    expect(tAfter).toHaveLength(1)
    expect(tAfter[0]!.operation).toBe('ops:upload-bank-file')
  })

  it('the DENY 6e is DURABLY committed (own tx) and survives the request rejection, and an authz-deny (not just step-up) is durable too', async () => {
    // A step-up-required DENY: a stale auth_time -> 403, yet a SEPARATE query
    // (a fresh committed read) sees the DENY row = it was durably committed,
    // not held in an aborted request tx and not swallowed.
    const now = Math.floor(Date.now() / 1000)
    const stepUpToken = await mint({ auth_time: now - 1000 })
    const stepUpRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${randomUUID()}/override`)
      .set('Authorization', `Bearer ${stepUpToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'DELIVERED', courierTimestamp: '2026-07-27T10:00:00Z', overrideReason: 'x' })
    expect(stepUpRes.status).toBe(403)

    // An authz-deny (a psr resolving to no ops role) on a non-catalog action.
    const noRoleToken = await mint({ psr: 'role:not_ops' })
    const authzRes = await request(app.getHttpServer())
      .post(`/ops/shipments/${seeded.shptId}/correct`)
      .set('Authorization', `Bearer ${noRoleToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ status: 'OUT_FOR_DELIVERY', courierTimestamp: '2026-07-27T11:00:00Z' })
    expect(authzRes.status).toBe(403)
    // No domain effect for the rejected correction.
    expect(await shptStatus(seeded.shptId)).toBe('IN_TRANSIT')

    const rows = await readFulfillmentAudit()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.decision === 'DENY')).toBe(true)
    expect(rows.map((r) => r.reasonCode).sort()).toEqual(['step-up-required', 'unknown-role'])
  })

  it('exactly ONE 6e per ACTUAL mutation: a client-key replay emits NO new 6e, and a READ emits no 6e at all', async () => {
    const token = await mint({})
    const idem = randomUUID()

    // First correct: advances and co-commits ONE ALLOW.
    const first = await request(app.getHttpServer())
      .post(`/ops/shipments/${seeded.shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem)
      .send({ status: 'OUT_FOR_DELIVERY', courierTimestamp: '2026-07-27T11:00:00Z' })
    expect(first.status).toBe(200)
    expect(await readFulfillmentAudit()).toHaveLength(1)

    // A replay with the SAME Idempotency-Key: the onceWithin callback never
    // runs, so no new 6e is emitted (the co-commit enqueue lives INSIDE that
    // callback). Exactly one 6e per actual mutation, not per request.
    const replay = await request(app.getHttpServer())
      .post(`/ops/shipments/${seeded.shptId}/correct`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idem)
      .send({ status: 'OUT_FOR_DELIVERY', courierTimestamp: '2026-07-27T11:00:00Z' })
    expect(replay.status).toBe(200)
    expect(replay.body.deduped).toBe(true)
    expect(await readFulfillmentAudit()).toHaveLength(1)

    // A READ (guard-only, no mutation) emits no 6e in either outbox.
    const readRes = await request(app.getHttpServer())
      .get('/ops/vendors')
      .set('Authorization', `Bearer ${token}`)
    expect(readRes.status).toBe(200)
    expect(await readFulfillmentAudit()).toHaveLength(1)
    expect(await readTmsAudit()).toHaveLength(0)
  })
})
