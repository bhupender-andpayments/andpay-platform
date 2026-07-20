import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { authenticator } from 'otplib'
import { newId } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { LocalEs256Adapter } from '../src/ports/kms-signing.js'
import { LocalPepperAdapter } from '../src/ports/pepper.js'
import { TotpAdapter } from '../src/ports/mfa.js'
import { login, type LoginDeps } from '../src/login.js'
import { authorizeAudited } from '../src/authorize.js'
import { issueVendorCredential } from '../src/credentials.js'
import { loadConfig } from '../src/config/index.js'
import { AUTH_ISS } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })
const pepper = 'dev-pepper-not-a-real-secret'
const pepperPort = new LocalPepperAdapter(pepper)
const PASSWORD = 'correct horse battery staple'
const totpSecret = authenticator.generateSecret()
const opsId = randomUUID()
const vndrId = newId('vndr')
let signer: LocalEs256Adapter

function opsClaim(): LeanClaim {
  return {
    iss: AUTH_ISS, sub: opsId, aud: 'andpay:internal-admin', iat: 1000, exp: 1600, nbf: 1000, jti: 'j',
    cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 1000,
  }
}
function loginDeps(): LoginDeps {
  return {
    db, signer, mfa: new TotpAdapter(),
    mfaSecretResolver: async (id: string) => (id === opsId ? totpSecret : undefined),
    iss: AUTH_ISS, accessTtlSec: 600, idleSec: 1800, absoluteSec: 28800, clientBind: 'client-A', traceId: 'trace-login',
  }
}

beforeAll(async () => {
  await db.$connect()
  signer = await LocalEs256Adapter.create('dev-1')
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await db.outbox.deleteMany({})
  await db.refreshToken.deleteMany({})
  await db.vendorCredential.deleteMany({})
  await db.mfaEnrollment.deleteMany({})
  await db.internalPrincipal.deleteMany({})
  await db.internalPrincipal.create({ data: { id: opsId, loginHandle: 'ops1', passwordHash: await argonHash(PASSWORD), status: 'ACTIVE', role: 'ops' } })
})

describe('6e authz-audit emission via the outbox (check 8)', () => {
  it('an authentication emits an IDs-only authz.audit record (no password, no secret)', async () => {
    await login('ops1', PASSWORD, authenticator.generate(totpSecret), loginDeps())
    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const loginAudit = audits.find((a) => JSON.stringify(a.payload).includes('"operation":"login"'))
    expect(loginAudit).toBeDefined()
    const json = JSON.stringify(loginAudit!.payload)
    expect(json.includes('"decision":"ALLOW"')).toBe(true)
    expect(json.includes(PASSWORD)).toBe(false)
    expect(json.includes(totpSecret)).toBe(false)
  })

  it('every DENY emits an authz.audit record', async () => {
    const decision = await authorizeAudited(opsClaim(), 'mfa:reset', {}, { db, cfg: loadConfig(), traceId: 'trace-deny' })
    expect(decision.allowed).toBe(false)
    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const deny = audits.find((a) => JSON.stringify(a.payload).includes('"decision":"DENY"'))
    expect(deny).toBeDefined()
    expect(JSON.stringify(deny!.payload).includes('mfa:reset')).toBe(true)
  })

  it('a routine ALLOW through authorizeAudited does not spam the audit (only DENYs)', async () => {
    await authorizeAudited(opsClaim(), 'vendor_credential:create', {}, { db, cfg: loadConfig(), traceId: 't' })
    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    expect(audits).toHaveLength(0)
  })

  it('a vendor-credential issuance emits an authz.audit record with no secret', async () => {
    const { secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-audit' },
      { operatorId: opsId, claim: opsClaim() },
      { db, pepper: pepperPort, traceId: 'trace-issue', now: 1000 },
    )
    const audits = await db.outbox.findMany({ where: { eventType: 'authz.audit' } })
    const issue = audits.find((a) => JSON.stringify(a.payload).includes('vendor_credential:create'))
    expect(issue).toBeDefined()
    expect(JSON.stringify(issue!.payload).includes(secret)).toBe(false)
  })
})
