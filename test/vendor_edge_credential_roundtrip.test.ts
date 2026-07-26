import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { LeanClaim } from '@andpay/authz'
import {
  PrismaClient as AuthClient,
  issueVendorCredential,
  LocalPepperAdapter,
} from '@andpay/auth-service'
import {
  PrismaClient as FulfillmentClient,
  projectCredentialConfig,
  loadCredentialProjection,
  type CredentialConfigPayload,
} from '@andpay/fulfillment-service'
import { resolveClaimFromAuthHeader } from '@andpay/edge'

// Root-only integration seam (mirrors test/fulfillment_auth_roundtrip.test.ts's
// precedent): this is the ONE place proving check 1 end to end -- a REAL
// Auth-issued class-6 credential resolves LOCALLY at the fulfillment edge,
// with ZERO call to Auth at resolution. Auth issues (its own db/schema);
// fulfillment projects the cfg.auth.credential.v1 payload into its OWN
// credential_projection (a different db/schema entirely); @andpay/edge
// resolves the presented secret against ONLY the loaded projection map, never
// touching authDb. Each service gets its OWN Prisma client, pinned to its OWN
// schema (C4).
const authUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const authDb = new AuthClient({ datasourceUrl: authUrl })
const fulfillmentDb = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

// The 5c pepper: the SAME underlying key builds the issue-side PepperPort (an
// HMAC adapter) and the resolve-side raw pepper, so the peppered-hash lookup
// matches (mirrors services/auth/test/vendor-credential.test.ts and
// test/fulfillment_auth_roundtrip.test.ts exactly).
const pepper = 'dev-pepper-not-a-real-secret'
const pepperPort = new LocalPepperAdapter(pepper)

// A class-3 ops actor whose claim satisfies the vendor_credential:create
// step-up (STEP_UP_CATALOG requires AAL2, fresh within 300s of auth_time):
// mirrors test/fulfillment_auth_roundtrip.test.ts's opsClaim fixture verbatim.
const operatorId = randomUUID()
function opsActorClaim(authTime: number): LeanClaim {
  return {
    iss: 'andpay-auth',
    sub: operatorId,
    aud: 'andpay:internal-admin',
    iat: authTime,
    exp: authTime + 600,
    nbf: authTime,
    jti: 'jti-edge-roundtrip-ops-1',
    cls: 3,
    mode: 'test',
    scope: {},
    psr: 'role:ops',
    epoch: 1,
    acr: 'AAL2',
    amr: ['pwd', 'otp'],
    auth_time: authTime,
  }
}
const opsActor = { operatorId, claim: opsActorClaim(1000) }

beforeEach(async () => {
  await authDb.$executeRawUnsafe('TRUNCATE vendor_credential, denylist, authz_audit, outbox, inbox')
  await fulfillmentDb.$executeRawUnsafe('TRUNCATE credential_projection, outbox, inbox')
})
afterAll(async () => {
  await authDb.$disconnect()
  await fulfillmentDb.$disconnect()
})

interface CfgOutboxRow {
  payload: Envelope<CredentialConfigPayload>
}

describe('edge credential roundtrip (check 1): a REAL Auth-issued class-6 credential resolves LOCALLY at the fulfillment edge', () => {
  it('issueVendorCredential (COURIER) -> read cfg.auth.credential.v1 -> projectCredentialConfig -> loadCredentialProjection -> resolveClaimFromAuthHeader resolves a cls:6 claim scoped to the issued vendor, no acr/amr, zero call to Auth at resolution', async () => {
    const vndrId = newId('vndr')
    const workQueue = 'wq-edge-courier'

    // 1. Auth issues the class-6 vendor credential (permissionSetRef
    // vset:vendor_courier). This emits BOTH fct.auth.credential.v1 (the
    // public lifecycle fact) and cfg.auth.credential.v1 (the 5c auth-config
    // channel this test consumes below), atomically with the row write.
    const issued = await issueVendorCredential(
      { vndrId, workQueue, permissionSetRef: 'vset:vendor_courier', mode: 'test', idempotencyKey: 'edge-roundtrip-1' },
      opsActor,
      { db: authDb, pepper: pepperPort, traceId: 'trace-edge-issue', now: 1000 },
    )
    expect(issued.reused).toBe(false)
    expect(issued.secret.startsWith('apsk_test_')).toBe(true)
    expect(issued.apiId.startsWith('api_')).toBe(true)

    // 2. Read the emitted cfg.auth.credential.v1 outbox row from AUTH's own
    // outbox (simulating the relay having delivered it), and replicate it
    // into fulfillment's OWN credential_projection. No cross-context DB read:
    // this is a read of authDb's outbox followed by a write to fulfillmentDb,
    // exactly the shape a real bus consumer would perform.
    const cfgRows = await authDb.$queryRaw<CfgOutboxRow[]>`
      SELECT payload FROM outbox WHERE event_type = 'cfg.auth.credential.v1' ORDER BY created_at ASC
    `
    expect(cfgRows).toHaveLength(1)
    const env = cfgRows[0]!.payload
    expect(env.payload.apiId).toBe(issued.apiId)
    expect(env.payload.vndrId).toBe(vndrId)
    expect(env.payload.status).toBe('ACTIVE')

    const projectRes = await projectCredentialConfig(fulfillmentDb, env)
    expect(projectRes.upserted).toBe(true)

    // 3. Load the projection (the async->sync bridge the real edge guard
    // uses, apps/vendor-edge/src/guard.ts) and resolve the REAL show-once
    // secret against it. This call touches ONLY fulfillmentDb (via `map`,
    // already loaded) and the injected raw pepper: authDb is never passed to
    // resolveClaimFromAuthHeader or its lookup closure, so resolution cannot
    // reach Auth's own vendor_credential table even by accident.
    const map = await loadCredentialProjection(fulfillmentDb)
    const claim = await resolveClaimFromAuthHeader(`Bearer ${issued.secret}`, {
      pepper,
      lookup: (h) => map.get(h),
      expectedPlane: 'andpay:vendor',
      expectedMode: 'test',
    })

    expect(claim.cls).toBe(6)
    expect(claim.sub).toBe(issued.apiId)
    expect(claim.aud).toBe('andpay:vendor')
    expect(claim.mode).toBe('test')
    expect(claim.scope.vndr).toBe(vndrId)
    expect(claim.scope.wq).toBe(workQueue)
    expect(claim.psr).toBe('vset:vendor_courier')
    // Class 6 carries no acr/amr/auth_time: assurance IS the credential, no
    // MFA, no session (5f).
    expect(claim.acr).toBeUndefined()
    expect(claim.amr).toBeUndefined()
    expect(claim.auth_time).toBeUndefined()
  })
})
