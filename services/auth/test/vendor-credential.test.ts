import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { LocalPepperAdapter } from '../src/ports/pepper.js'
import { issueVendorCredential, revokeVendorCredential, resolveVendorCredential } from '../src/credentials.js'
import { addToDenylist } from '../src/denylist.js'
import { AUTH_CREDENTIAL_TOPIC } from '../src/events.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })
const pepper = 'dev-pepper-not-a-real-secret'
const pepperPort = new LocalPepperAdapter(pepper)
const vndrId = newId('vndr')
const operatorId = randomUUID()

function opsClaim(authTime: number, acr: 'AAL1' | 'AAL2' = 'AAL2'): LeanClaim {
  return {
    iss: 'andpay-auth', sub: operatorId, aud: 'andpay:internal-admin', iat: authTime, exp: authTime + 600, nbf: authTime,
    jti: 'j', cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr, amr: ['pwd', 'otp'], auth_time: authTime,
  }
}
const operator = { operatorId, claim: opsClaim(1000) }

beforeAll(async () => {
  await db.$connect()
})
afterAll(async () => {
  await db.$disconnect()
})
beforeEach(async () => {
  await db.vendorCredential.deleteMany({})
  await db.denylist.deleteMany({})
  await db.outbox.deleteMany({})
})

describe('class-6 vendor credential lifecycle (105, 5a-5e, check 5)', () => {
  it('issues a show-once credential stored only as a peppered HMAC (5c)', async () => {
    const { apiId, secret, reused } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-1' },
      operator,
      { db, pepper: pepperPort, traceId: 'trace-1', now: 1000 },
    )
    expect(reused).toBe(false)
    expect(secret.startsWith('apsk_live_')).toBe(true)
    expect(apiId.startsWith('api_')).toBe(true)
    const rows = await db.vendorCredential.findMany({})
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.pepperedHash).toBe(pepperPort.hmac(secret))
    expect(row.status).toBe('ACTIVE')
    // The raw secret and its random body appear in NO column (S4, stored only hashed).
    const body = secret.slice('apsk_live_'.length)
    expect(JSON.stringify(row).includes(secret)).toBe(false)
    expect(JSON.stringify(row).includes(body)).toBe(false)
  })

  it('resolves the live credential to the uniform class-6 claim, fail-closed after revoke (5d)', async () => {
    const { apiId, secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-2' },
      operator, { db, pepper: pepperPort, traceId: 't', now: 1000 },
    )
    const claim = await resolveVendorCredential(secret, { db, pepper, expectedMode: 'live' })
    expect(claim.cls).toBe(6)
    expect(claim.sub).toBe(apiId)
    expect(claim.scope.vndr).toBe(vndrId)
    expect(claim.scope.wq).toBe('wq-A')
    expect(claim.acr).toBeUndefined()
    await revokeVendorCredential(apiId, { db, traceId: 't', now: 2000 })
    await expect(resolveVendorCredential(secret, { db, pepper, expectedMode: 'live' })).rejects.toThrow()
  })

  it('is idempotent on the 06.A key: a retry returns the same api_ id and mints no second secret (Section 10)', async () => {
    const first = await issueVendorCredential({ vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-3' }, operator, { db, pepper: pepperPort, traceId: 't', now: 1000 })
    const retry = await issueVendorCredential({ vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-3' }, operator, { db, pepper: pepperPort, traceId: 't', now: 1000 })
    expect(retry.reused).toBe(true)
    expect(retry.apiId).toBe(first.apiId)
    expect(retry.secret).toBe('')
    expect(await db.vendorCredential.count()).toBe(1)
  })

  it('denylist kills a valid ACTIVE credential immediately (D3)', async () => {
    const { apiId, secret } = await issueVendorCredential({ vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-4' }, operator, { db, pepper: pepperPort, traceId: 't', now: 1000 })
    await resolveVendorCredential(secret, { db, pepper, expectedMode: 'live' }) // ACTIVE, resolves
    await addToDenylist(db, apiId, 'incident')
    await expect(resolveVendorCredential(secret, { db, pepper, expectedMode: 'live' })).rejects.toThrow()
  })

  it('emits an IDs-only fct.auth.credential.v1 fact, no secret, partition-keyed by api_ id', async () => {
    const { apiId, secret } = await issueVendorCredential({ vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-5' }, operator, { db, pepper: pepperPort, traceId: 'trace-x', now: 1000 })
    const outbox = await db.outbox.findMany({ where: { eventType: AUTH_CREDENTIAL_TOPIC } })
    expect(outbox).toHaveLength(1)
    const ev = outbox[0]!
    expect(ev.partitionKey).toBe(apiId)
    const json = JSON.stringify(ev.payload)
    expect(json.includes(apiId)).toBe(true)
    expect(json.includes(vndrId)).toBe(true)
    expect(json.includes('ACTIVE')).toBe(true)
    expect(json.includes(secret)).toBe(false)
  })

  it('rejects an unknown or non-class-6 permission set (105d structural exclusion)', async () => {
    await expect(
      issueVendorCredential({ vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:bogus', mode: 'live', idempotencyKey: 'req-6' }, operator, { db, pepper: pepperPort, traceId: 't', now: 1000 }),
    ).rejects.toThrow()
  })

  it('denies issuance without a fresh AAL2 step-up (6b)', async () => {
    const weak = { operatorId, claim: opsClaim(1000, 'AAL1') }
    await expect(
      issueVendorCredential({ vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'req-7' }, weak, { db, pepper: pepperPort, traceId: 't', now: 1000 }),
    ).rejects.toThrow()
  })

  it('resolveVendorCredential fails closed on an unknown or malformed secret (5e), distinct from revoke', async () => {
    await expect(resolveVendorCredential('apsk_live_UNKNOWNSECRETVALUE000000000000', { db, pepper, expectedMode: 'live' })).rejects.toThrow()
    await expect(resolveVendorCredential('not-an-apsk-secret', { db, pepper, expectedMode: 'live' })).rejects.toThrow()
  })
})
