import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { authenticator } from 'otplib'
import { hash as argonHash } from '@node-rs/argon2'
import { requireStepUp, type Amr } from '@andpay/authz'
import { PrismaClient, type AuthDb, stepUp, enrollTotp, LocalEs256Adapter, TotpAdapter } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
let signer: LocalEs256Adapter
const principalId = randomUUID()
const handle = `stepup-${principalId.slice(0, 8)}`
const vault = new Map<string, string>()
const storeSecret = async (pid: string, secret: string) => { const r = `vault://${pid}`; vault.set(r, secret); return r }
// Custody is keyed by the REFERENCE the enrollment row carries, matching
// production: one key per enrollment, never one per principal.
const resolveSecretRef = async (ref: string) => vault.get(ref)
let secret: string

async function auditRows(pid: string) {
  return db.$queryRawUnsafe<{ payload: { operation: string; decision: string; reasonCode?: string; acr?: string; authTime?: string } }[]>(
    `SELECT payload FROM outbox WHERE event_type='authz.audit' AND aggregate_id='${pid}' ORDER BY created_at ASC`,
  )
}

// A presented (already-verified) class-3 claim, as verifyAccessToken would return.
function presented(authTime: number) {
  return { iss: 'https://auth.andpay.test', sub: principalId, aud: 'andpay:internal-admin' as const, iat: authTime, exp: authTime + 600, nbf: authTime, jti: randomUUID(), cls: 3 as const, mode: 'live' as const, scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2' as const, amr: ['pwd', 'otp'] as Amr[], auth_time: authTime }
}

beforeAll(async () => {
  db = new PrismaClient({ datasourceUrl: url })
  signer = await LocalEs256Adapter.create('stepup-key')
  await db.internalPrincipal.create({ data: { id: principalId, loginHandle: handle, passwordHash: await argonHash('pw'), status: 'ACTIVE', role: 'ops' } })
  const { otpauthUri } = await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
  secret = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')!
})
afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id='${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_id='${principalId}'`)
  await db.internalPrincipal.delete({ where: { id: principalId } })
  await db.$disconnect()
})
beforeEach(async () => { await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id='${principalId}'`) })

const deps = () => ({ db, signer, mfa: new TotpAdapter(), resolveSecretRef, iss: 'https://auth.andpay.test', accessTtlSec: 600 })

describe('stepUp mint (spec 12a task 1)', () => {
  it('a correct TOTP mints a claim with auth_time advanced past the presented one, and a subsequent requireStepUp PASSES where it FAILED before', async () => {
    const staleAuthTime = Math.floor(Date.now() / 1000) - 10_000 // older than any 300s freshness
    const pres = presented(staleAuthTime)
    // the presented (stale) claim FAILS a 300s step-up freshness check
    expect(() => requireStepUp(pres, { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false }, Math.floor(Date.now() / 1000))).toThrow()
    const now = Math.floor(Date.now() / 1000)
    const { accessToken } = await stepUp(pres, authenticator.generate(secret), { ...deps(), traceId: randomUUID(), now })
    // decode the minted token's auth_time via the signer's own jwks
    const { jwtVerify, createLocalJWKSet } = await import('jose')
    const { payload } = await jwtVerify(accessToken, createLocalJWKSet(await signer.jwks()), { issuer: 'https://auth.andpay.test', audience: 'andpay:internal-admin' })
    expect(payload.auth_time).toBe(now)
    expect(Number(payload.auth_time)).toBeGreaterThan(staleAuthTime)
    expect(payload.sub).toBe(principalId)
    expect(payload.cls).toBe(3)
    expect(payload.mode).toBe('live')
    expect(payload.acr).toBe('AAL2')
    // the MINTED claim PASSES the same freshness check
    expect(() => requireStepUp(payload as never, { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false }, now)).not.toThrow()
    // exactly one synchronous-standalone ALLOW audit committed
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.operation).toBe('step-up')
    expect(rows[0]!.payload.decision).toBe('ALLOW')
  })

  it('a wrong TOTP DENIES: throws mfa-failed, mints nothing, and commits exactly one synchronous-standalone DENY audit', async () => {
    const pres = presented(Math.floor(Date.now() / 1000))
    await expect(stepUp(pres, '000000', { ...deps(), traceId: randomUUID() })).rejects.toThrow('mfa-failed')
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    expect(rows[0]!.payload.reasonCode).toBe('mfa-failed')
  })

  it('stepUp writes no refresh_token row (family untouched)', async () => {
    const before = await db.refreshToken.count({ where: { principalId } })
    await stepUp(presented(Math.floor(Date.now() / 1000)), authenticator.generate(secret), { ...deps(), traceId: randomUUID() })
    const after = await db.refreshToken.count({ where: { principalId } })
    expect(after).toBe(before)
  })
})
