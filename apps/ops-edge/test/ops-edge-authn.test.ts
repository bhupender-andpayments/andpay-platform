import 'reflect-metadata'
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { generateKeyPair, exportJWK, SignJWT, type JSONWebKeySet } from 'jose'
import type { INestApplication } from '@nestjs/common'
import { PrismaClient as FulfillmentClient, loadOpsConfig, InMemoryAssetStore } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient } from '@andpay/analytics-service'
import { buildOpsEdgeApp, type OpsEdgeDeps } from '../src/index.js'

// The REAL app, real in-process HTTP via supertest against app.getHttpServer(),
// no bound port. The ops edge is the class-3 internal-admin HTTP edge (JWT via
// a LOCAL JWKS, zero call to Auth on the request path), structurally identical
// to the tenant edge. This suite exercises the guard only (Part A): check 4
// (mode AND audience both gated), the apsk_/class-6 rejection at the human
// edge, the defense-in-depth class-3 gate, and the fail-closed authn-DENY 6e
// emission on every rejection. Part B adds the ops action controllers, the
// step-up gate, and the per-action 6e ALLOW/DENY emission.
const EXPECTED_ISS = 'https://auth.andpay.test/ops'
const KID = 'ops-edge-test-key-1'

const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })
const tmsDb = new TmsClient({ datasourceUrl: tmsUrl })
// ADDITIVE (spec 11 task 8): OpsEdgeDeps now requires an analyticsDb; wired for
// construction only (this authn suite never exercises the reporting routes).
const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })

let app: INestApplication
let jwks: JSONWebKeySet
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
// Fix 4 regressions (mirrored from the tenant edge): a second ES256 keypair
// never added to the injected JWKS (proves a correctly-shaped,
// correctly-signed-but-wrong-signer token is rejected), and an RSA keypair
// (proves the verifier's algorithms:['ES256'] pin rejects an RS256-signed
// token regardless of key validity).
let wrongSignerKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let rsPrivateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

// Mint an ES256 at+jwt access token. Every field the LeanClaim carries is set
// here; a caller overrides any of them to drive a specific rejection. `mode`
// can be removed entirely by passing `mode: undefined`, which JSON drops, to
// prove the mode gate rejects a token that never asserted a mode at all.
async function mint(claim: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_1',
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'pset:ops_portal',
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

// A fully-parameterized mint (Fix 4): every crypto-posture knob (signing key,
// alg, kid, issuer, iat/nbf/exp) is overridable, so each regression test mints
// a token that is malformed in EXACTLY one dimension.
async function mintWith(params: {
  signingKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
  alg?: string
  kid?: string
  iss?: string
  iat?: number
  nbf?: number
  exp?: number
  claim?: Record<string, unknown>
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    sub: 'user_ops_1',
    cls: 3,
    mode: 'live',
    aud: 'andpay:internal-admin',
    scope: {},
    psr: 'pset:ops_portal',
    epoch: 1,
    jti: randomUUID(),
    ...params.claim,
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: params.alg ?? 'ES256', typ: 'at+jwt', kid: params.kid ?? KID })
    .setIssuedAt(params.iat ?? now)
    .setNotBefore(params.nbf ?? now)
    .setExpirationTime(params.exp ?? now + 300)
    .setIssuer(params.iss ?? EXPECTED_ISS)
    .sign(params.signingKey)
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

// Fix 5: the RAW row, undestructured, so a leak assertion checks the actual
// persisted JSON rather than the helper's own (necessarily incomplete) view.
async function rawAuditRows(): Promise<unknown[]> {
  const rows = await fulfillmentDb.$queryRaw<
    { payload: unknown }[]
  >`SELECT payload FROM outbox WHERE event_type = 'authz.audit' ORDER BY created_at ASC`
  return rows.map((r) => r.payload)
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256')
  privateKey = kp.privateKey
  const jwk = await exportJWK(kp.publicKey)
  jwk.alg = 'ES256'
  jwk.use = 'sig'
  jwk.kid = KID
  jwks = { keys: [jwk] }

  // A second ES256 keypair, never added to jwks above (Fix 4: wrong signer).
  const wrongKp = await generateKeyPair('ES256')
  wrongSignerKey = wrongKp.privateKey

  // An RSA keypair (Fix 4: alg-pin rejection). Never added to jwks; the
  // verifier's algorithms:['ES256'] pin must reject an RS256 header before
  // any key lookup even matters.
  const rsKp = await generateKeyPair('RS256')
  rsPrivateKey = rsKp.privateKey

  const deps: OpsEdgeDeps = {
    tmsDb,
    fulfillmentDb,
    analyticsDb,
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
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE outbox CASCADE')
})

describe('ops-edge guard: a valid live class-3 internal-admin JWT authenticates', () => {
  it('a live class-3 internal-admin JWT reaches the guarded probe (200) and writes NO authz-audit row', async () => {
    const token = await mint({})
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.cls).toBe(3)
    expect(res.body.mode).toBe('live')
    // A successful authentication emits NOTHING: the authz-audit outbox is DENY-only here.
    expect(await auditRows()).toHaveLength(0)
  })
})

describe('ops-edge guard: the mode gate (check 4) rejects a non-live token', () => {
  it('a class-3 internal-admin JWT with mode:test -> 401 with exactly one mode-mismatch authn-DENY row', async () => {
    const token = await mint({ mode: 'test' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.operation).toBe('authenticate')
    expect(rows[0]!.reasonCode).toBe('mode-mismatch')
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.principalId).toBe('unknown')
    expect(rows[0]!.actorChannel).toBe('human-direct')
  })

  it('a class-3 internal-admin JWT with NO mode claim -> 401 (the mode gate rejects an absent mode)', async () => {
    const token = await mint({ mode: undefined })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.reasonCode).toBe('mode-mismatch')
  })
})

describe('ops-edge guard: the audience gate (check 4) rejects a wrong-plane token', () => {
  it('a JWT minted for andpay:tenant-portal -> 401 (the verifier pins its own aud to the internal-admin plane)', async () => {
    const token = await mint({ aud: 'andpay:tenant-portal' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
    // Fix 5: broaden the DENY-record invariant beyond decision/reasonCode.
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.principalId).toBe('unknown')
    expect(rows[0]!.actorChannel).toBe('human-direct')
    expect(rows[0]!.operation).toBe('authenticate')
  })
})

describe('ops-edge guard: an apsk_ credential (class 6) is rejected at the human edge', () => {
  it('an apsk_ bearer -> 401 (no credential projection is wired at the ops edge, so it fails closed)', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe')
      .set('Authorization', 'Bearer apsk_live_ops-should-never-work-aaaaaaaaaaaaaa')
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('credential-unknown')
    // Fix 5: broaden the DENY-record invariant beyond decision/reasonCode.
    expect(rows[0]!.cls).toBe(3)
    expect(rows[0]!.principalId).toBe('unknown')
    expect(rows[0]!.actorChannel).toBe('human-direct')
    expect(rows[0]!.operation).toBe('authenticate')
  })
})

describe('ops-edge guard: missing/garbage Authorization headers fail closed', () => {
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

  it('an empty Bearer header (nothing after "Bearer ") -> 401 with exactly one authn-DENY row', async () => {
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', 'Bearer ')
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
  })
})

describe('ops-edge guard: class-6 is never valid as a JWT, even with a correct signature (Fix 4)', () => {
  it('a validly ES256-signed internal-admin JWT with cls:6 -> 401 (class6-jwt-rejected)', async () => {
    const token = await mint({ cls: 6 })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('class6-jwt-rejected')
  })
})

describe('ops-edge guard: the explicit class-3 gate (Fix 3) rejects any non-3, non-6 class', () => {
  it('a validly ES256-signed internal-admin JWT with cls:2 -> 401 (class-not-ops)', async () => {
    const token = await mint({ cls: 2 })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('class-not-ops')
  })
})

describe('ops-edge guard: crypto-posture regressions (Fix 4), each malformed in exactly one dimension', () => {
  it('an RS256-signed token is rejected (the verifier pins algorithms:[ES256])', async () => {
    const token = await mintWith({ signingKey: rsPrivateKey, alg: 'RS256' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
  })

  it('a token signed by a different ES256 key not in the injected JWKS -> reject (wrong signer)', async () => {
    const token = await mintWith({ signingKey: wrongSignerKey })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
  })

  it('an expired token (exp in the past) is rejected', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintWith({ signingKey: privateKey, iat: now - 600, nbf: now - 600, exp: now - 300 })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })

  it('a not-yet-valid token (nbf in the future) is rejected', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintWith({ signingKey: privateKey, nbf: now + 300, exp: now + 600 })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })

  it('a wrong-issuer token (iss != expectedIss) is rejected', async () => {
    const token = await mintWith({ signingKey: privateKey, iss: 'https://auth.andpay.test/OTHER' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.decision).toBe('DENY')
    expect(rows[0]!.reasonCode).toBe('token-verify-failed')
  })
})

describe('ops-edge guard: the authz-audit outbox row never carries the presented token (Fix 5)', () => {
  it('the RAW outbox payload does not contain the rejected token bytes', async () => {
    const token = await mint({ mode: 'test' })
    const res = await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)

    const raw = await rawAuditRows()
    expect(raw).toHaveLength(1)
    expect(JSON.stringify(raw[0])).not.toContain(token)
  })
})
