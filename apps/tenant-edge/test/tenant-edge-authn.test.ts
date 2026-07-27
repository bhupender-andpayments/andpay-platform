import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { buildTenantEdgeApp, type TenantEdgeDeps } from '../src/index.js'

// The REAL app, real in-process HTTP via supertest against app.getHttpServer(),
// no bound port. The tenant edge is the FIRST human-plane HTTP edge (class 2,
// JWT via a LOCAL JWKS, zero call to Auth on the request path). This suite
// exercises the guard only: check 4 (mode AND audience both gated), the
// apsk_/class-6 rejection at the human edge, and the fail-closed authn-DENY 6e
// emission on every rejection.
const EXPECTED_ISS = 'https://auth.andpay.test/tenant'
const KID = 'tenant-edge-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })

let app: INestApplication
let jwks: JSONWebKeySet
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// Mint an ES256 at+jwt access token. Every field the LeanClaim carries is set
// here; a caller overrides any of them to drive a specific rejection. `mode`
// can be removed entirely by passing `mode: undefined`, which JSON drops, to
// prove the mode gate rejects a token that never asserted a mode at all.
async function mint(claim: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_tenant_ops_1',
    cls: 2,
    mode: 'live',
    aud: 'andpay:tenant-portal',
    scope: { tid: 'tnnt_1' },
    psr: 'pset:tenant_ops',
    epoch: 1,
    jti: randomUUID(),
    ...claim,
  }
  if (payload.mode === undefined) delete payload.mode
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KID })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .setIssuer(EXPECTED_ISS)
    .sign(privateKey)
}

interface AuditOutboxRow {
  decision: string
  operation: string
  reasonCode: string | undefined
  cls: number
  principalId: string
  actorChannel: string | undefined
}

async function auditRows(): Promise<AuditOutboxRow[]> {
  const rows = await fulfillmentDb.$queryRaw<
    {
      payload: {
        decision: string
        operation: string
        reasonCode?: string
        cls: number
        principalId: string
        actorChannel?: string
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
  }))
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  jwks = { keys: [jwk] }

  const deps: TenantEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    jwks,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
  }
  app = await buildTenantEdgeApp(deps)
  await app.init()
})

afterAll(async () => {
  await app.close()
  await fulfillmentDb.$disconnect()
  await tmsDb.$disconnect()
})

beforeEach(async () => {
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox CASCADE')
})

describe('tenant-edge guard: a valid live class-2 tenant-portal JWT authenticates', () => {
  it('a live class-2 tenant-portal JWT reaches the guarded probe (200) and writes NO authz-audit row', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.cls).toBe(2)
    expect(res.body.mode).toBe('live')
    // A successful authentication emits NOTHING: the authz-audit outbox is DENY-only here.
    expect(await auditRows()).toHaveLength(0)
  })
})

describe('tenant-edge guard: the mode gate (check 4) rejects a non-live token', () => {
  it('a class-2 tenant-portal JWT with mode:test -> 401 with exactly one mode-mismatch authn-DENY row', async () => {
    const token = await mint({ mode: 'test' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('mode-mismatch')
    expect(rows[0]!.cls).toBe(2)
    expect(rows[0]!.principalId).toBe('unknown')
    expect(rows[0]!.actorChannel).toBe('human-direct')
  })

  it('a class-2 tenant-portal JWT with NO mode claim -> 401 (the mode gate rejects an absent mode)', async () => {
    const token = await mint({ mode: undefined })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('mode-mismatch')
  })
})

describe('tenant-edge guard: the audience gate (check 4) rejects a wrong-plane token', () => {
  it('a JWT minted for andpay:internal-admin -> 401 (the verifier pins its own aud to the tenant plane)', async () => {
    const token = await mint({ aud: 'andpay:internal-admin' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })
})

describe('tenant-edge guard: an apsk_ credential (class 6) is rejected at the human edge', () => {
  it('an apsk_ bearer -> 401 (no credential projection is wired at the tenant edge, so it fails closed)', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', 'Bearer apsk_live_tenant-should-never-work-aaaaaaaaaaaa')
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('credential-unknown')
  })
})

describe('tenant-edge guard: missing/garbage Authorization headers fail closed', () => {
  it('a missing Authorization header -> 401 with a missing-credential authn-DENY row', async () => {
    const res = await request(app.getHttpServer()).get('/probe')
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('missing-credential')
  })

  it('a non-Bearer garbage header -> 401 with a malformed-authorization authn-DENY row', async () => {
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', 'Basic Zm9vOmJhcg==')
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('malformed-authorization')
  })

  it('a Bearer with a non-JWT, non-apsk_ garbage value -> 401 (token-verify-failed)', async () => {
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', 'Bearer not.a.jwt')
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })
})
