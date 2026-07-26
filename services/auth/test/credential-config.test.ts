import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { newId } from '@andpay/ids'
import type { LeanClaim } from '@andpay/authz'
import { PrismaClient } from '../generated/client/index.js'
import { LocalPepperAdapter } from '../src/ports/pepper.js'
import { issueVendorCredential, revokeVendorCredential } from '../src/credentials.js'
import { AUTH_CREDENTIAL_TOPIC } from '../src/events.js'
import { CREDENTIAL_CONFIG_TOPIC, enqueueCredentialConfig, type CredentialConfigPayload } from '../src/credential-config.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
const db = new PrismaClient({ datasourceUrl: url })
const pepper = 'dev-pepper-not-a-real-secret'
const pepperPort = new LocalPepperAdapter(pepper)
const vndrId = newId('vndr')
const operatorId = randomUUID()

function opsClaim(authTime: number): LeanClaim {
  return {
    iss: 'andpay-auth', sub: operatorId, aud: 'andpay:internal-admin', iat: authTime, exp: authTime + 600, nbf: authTime,
    jti: 'j', cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: authTime,
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
  await db.outbox.deleteMany({})
})

describe('auth-config channel (5c, check 1): class-6 verification material', () => {
  it('issuing a vendor credential enqueues, in the SAME transaction, fct (no pepperedHash) and cfg (with pepperedHash + scope, ACTIVE)', async () => {
    const { apiId, secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'cfg-req-1' },
      operator,
      { db, pepper: pepperPort, traceId: 'trace-cfg-1', now: 1000 },
    )
    const pepperedHash = pepperPort.hmac(secret)

    const fctRows = await db.outbox.findMany({ where: { eventType: AUTH_CREDENTIAL_TOPIC } })
    expect(fctRows).toHaveLength(1)
    const fctJson = JSON.stringify(fctRows[0]!.payload)
    expect(fctJson.includes(apiId)).toBe(true)
    expect(fctJson.includes(pepperedHash)).toBe(false)
    expect(fctJson.includes(secret)).toBe(false)

    const cfgRows = await db.outbox.findMany({ where: { eventType: CREDENTIAL_CONFIG_TOPIC } })
    expect(cfgRows).toHaveLength(1)
    const cfgRow = cfgRows[0]!
    expect(cfgRow.partitionKey).toBe(apiId)
    const payload = cfgRow.payload as unknown as { payload: CredentialConfigPayload }
    expect(payload.payload.apiId).toBe(apiId)
    expect(payload.payload.pepperedHash).toBe(pepperedHash)
    expect(payload.payload.vndrId).toBe(vndrId)
    expect(payload.payload.workQueue).toBe('wq-A')
    expect(payload.payload.permissionSetRef).toBe('vset:vendor_print')
    expect(payload.payload.mode).toBe('live')
    expect(payload.payload.status).toBe('ACTIVE')
    expect(payload.payload.epoch).toBe(1)
  })

  it('E1: a cfg enqueue rolls back with the transaction (0), commits with it (1)', async () => {
    const payload: CredentialConfigPayload = {
      apiId: newId('api'),
      pepperedHash: 'phash-e1-probe',
      vndrId,
      workQueue: 'wq-A',
      permissionSetRef: 'vset:vendor_print',
      mode: 'live',
      status: 'ACTIVE',
      epoch: 1,
    }

    await expect(
      db.$transaction(async (tx) => {
        await enqueueCredentialConfig(tx, payload, 'trace-e1')
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')
    expect(await db.outbox.count({ where: { eventType: CREDENTIAL_CONFIG_TOPIC } })).toBe(0)

    await db.$transaction(async (tx) => {
      await enqueueCredentialConfig(tx, payload, 'trace-e1')
    })
    expect(await db.outbox.count({ where: { eventType: CREDENTIAL_CONFIG_TOPIC } })).toBe(1)
  })

  it('revoke emits a cfg.auth.credential.v1 with status REVOKED for the apiId', async () => {
    const { apiId, secret } = await issueVendorCredential(
      { vndrId, workQueue: 'wq-A', permissionSetRef: 'vset:vendor_print', mode: 'live', idempotencyKey: 'cfg-req-2' },
      operator,
      { db, pepper: pepperPort, traceId: 'trace-cfg-2', now: 1000 },
    )
    const pepperedHash = pepperPort.hmac(secret)

    await revokeVendorCredential(apiId, { db, traceId: 'trace-cfg-2-revoke', now: 2000 })

    const cfgRows = await db.outbox.findMany({
      where: { eventType: CREDENTIAL_CONFIG_TOPIC, partitionKey: apiId },
      orderBy: { createdAt: 'asc' },
    })
    expect(cfgRows).toHaveLength(2)
    const revoked = cfgRows[1]!
    const payload = revoked.payload as unknown as { payload: CredentialConfigPayload }
    expect(payload.payload.apiId).toBe(apiId)
    expect(payload.payload.status).toBe('REVOKED')
    expect(payload.payload.pepperedHash).toBe(pepperedHash)
    expect(payload.payload.vndrId).toBe(vndrId)
    expect(payload.payload.workQueue).toBe('wq-A')
    expect(payload.payload.permissionSetRef).toBe('vset:vendor_print')
    expect(payload.payload.mode).toBe('live')
  })
})
