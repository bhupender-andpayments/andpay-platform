import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId, toUuid } from '@andpay/ids'
import { authorize, type LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { LocalEs256Adapter } from '../src/ports/kms-signing.js'
import { LocalPepperAdapter } from '../src/ports/pepper.js'
import { issueAccessToken } from '../src/issue.js'
import { issueVendorCredential, resolveVendorCredential } from '../src/credentials.js'
import { loadConfig } from '../src/config/index.js'
import { redactSecrets } from '../src/redact.js'
import { UnwiredIdentityFactReader } from '../src/identity-seam.js'
import { AUTH_ISS } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })
const pepper = 'dev-pepper-not-a-real-secret'
const pepperPort = new LocalPepperAdapter(pepper)
const vndrId = newId('vndr')
const operatorId = randomUUID()
const runTag = operatorId.slice(0, 8)
let signer: LocalEs256Adapter

function opsClaim(): LeanClaim {
  return {
    iss: AUTH_ISS, sub: operatorId, aud: 'andpay:internal-admin', iat: 1000, exp: 1600, nbf: 1000, jti: 'j',
    cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 1000,
  }
}

beforeAll(async () => {
  await db.$connect()
  signer = await LocalEs256Adapter.create('dev-1')
})
afterAll(async () => {
  // Leave the schema as we found it: remove this run's own credentials.
  await db.vendorCredential.deleteMany({ where: { vndrId: toUuid(vndrId) } })
  await db.$disconnect()
})
beforeEach(async () => {
  // Scoped to this run's vendor. This suite shares the dev database with the
  // running ops portal, and the unfiltered deleteMany({}) it used to run wiped
  // every credential, denylist entry and outbox row in the schema. denylist and
  // outbox rows are keyed on per-test api_ ids, so there is nothing to clear.
  await db.vendorCredential.deleteMany({ where: { vndrId: toUuid(vndrId) } })
})

describe('distinct planes, class 6 never a JWT (check 6, 105f)', () => {
  it('an internal-admin JWT is rejected at the vendor edge (it is not an apsk_ secret)', async () => {
    const jwt = await issueAccessToken(
      { principalId: operatorId, cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, aud: 'andpay:internal-admin', acr: 'AAL2', amr: ['pwd', 'otp'], authTime: 1000 },
      { signer, iss: AUTH_ISS, ttlSec: 600, now: 1000 },
    )
    await expect(resolveVendorCredential(jwt, { db, pepper, expectedMode: 'live' })).rejects.toThrow()
  })

  it('a resolved class-6 credential carries the vendor plane, never the internal-admin plane', async () => {
    const { secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: `req-plane-${runTag}` },
      { operatorId, claim: opsClaim() }, { db, pepper: pepperPort, traceId: 't', now: 1000 },
    )
    const claim = await resolveVendorCredential(secret, { db, pepper, expectedMode: 'live' })
    expect(claim.aud).toBe('andpay:vendor')
    expect(claim.aud).not.toBe('andpay:internal-admin')
  })

  it('class 6 is never minted a JWT (issue returns a single-segment apsk_ secret, not a token)', async () => {
    const { secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: `req-nojwt-${runTag}` },
      { operatorId, claim: opsClaim() }, { db, pepper: pepperPort, traceId: 't', now: 1000 },
    )
    expect(secret.startsWith('apsk_')).toBe(true)
    expect(secret.split('.')).toHaveLength(1) // a JWT has three dot-separated segments; this has none
  })
})

describe('scope resolves without any Identity read (check 7, D121)', () => {
  it('class-3 scope resolves from config-as-code role to permission-set, no Identity reader', () => {
    const decision = authorize(opsClaim(), 'vendor_credential:create', {}, loadConfig())
    expect(decision.allowed).toBe(true)
  })

  it('class-6 scope resolves from the credential work-queue binding referencing a seeded vndr_', async () => {
    const { secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: `req-scope-${runTag}` },
      { operatorId, claim: opsClaim() }, { db, pepper: pepperPort, traceId: 't', now: 1000 },
    )
    const claim = await resolveVendorCredential(secret, { db, pepper, expectedMode: 'live' })
    expect(claim.scope.vndr).toBe(vndrId)
    expect(authorize(claim, 'batch:pull-artifacts', { vndrId, workQueue: 'wq-A' }, loadConfig()).allowed).toBe(true)
    expect(authorize(claim, 'batch:pull-artifacts', { vndrId: newId('vndr'), workQueue: 'wq-Z' }, loadConfig()).allowed).toBe(false)
  })

  it('the Identity fact-read seam is unwired: any call throws (never read in this slice)', async () => {
    await expect(new UnwiredIdentityFactReader().merchantById('mrch_anything')).rejects.toThrow()
  })
})

describe('secret redaction before the first log line (check 9, 5c)', () => {
  it('redacts an apsk_ secret from any log string', () => {
    const secret = 'apsk_live_ABCDEFGHIJKLMNOPqrstuvwxyz0123456789abcd'
    const line = `auth failure presenting ${secret} at the vendor edge`
    const redacted = redactSecrets(line)
    expect(redacted.includes(secret)).toBe(false)
    expect(redacted.includes('apsk_live_[REDACTED]')).toBe(true)
  })
})
