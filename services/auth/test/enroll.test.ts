import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { authenticator } from 'otplib'
import { PrismaClient, type AuthDb, enrollTotp, login, LocalEs256Adapter, TotpAdapter } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
let signer: LocalEs256Adapter
const handle = `enroll-${randomUUID()}`
let principalId: string
const vault = new Map<string, string>() // stand-in Secrets Manager

beforeAll(async () => {
  db = new PrismaClient({ datasourceUrl: url })
  signer = await LocalEs256Adapter.create('enroll-key')
  principalId = randomUUID()
  await db.internalPrincipal.create({ data: { id: principalId, loginHandle: handle, passwordHash: await argonHash('pw'), status: 'ACTIVE', role: 'admin' } })
})
afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_id = '${principalId}'`)
  await db.internalPrincipal.delete({ where: { id: principalId } })
  await db.$disconnect()
})
beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  vault.clear()
})

const storeSecret = async (pid: string, secret: string) => { const ref = `vault://${pid}`; vault.set(ref, secret); return ref }

describe('enrollTotp admin-seed (spec 12 task 6)', () => {
  it('stores no secret in the DB row, returns the otpauth URI once, and co-commits one enroll audit', async () => {
    const { otpauthUri } = await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true)
    const row = await db.mfaEnrollment.findFirst({ where: { principalId } })
    expect(row!.status).toBe('active')
    expect(row!.factor).toBe('totp')
    // the raw secret is recoverable from the URI but NEVER from the row
    const secretParam = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')
    expect(JSON.stringify(row)).not.toContain(secretParam)
    const n = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM outbox WHERE event_type='authz.audit' AND aggregate_id='${principalId}'`)
    expect(Number(n[0]!.n)).toBe(1)
  })

  it('a subsequent login with a TOTP computed from the seeded secret verifies AAL2', async () => {
    const { otpauthUri } = await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    const secret = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')!
    const mfaSecretResolver = async (pid: string) => vault.get(`vault://${pid}`)
    const totp = authenticator.generate(secret)
    const res = await login(handle, 'pw', totp, { db, signer, mfa: new TotpAdapter(), mfaSecretResolver, iss: 'https://auth.andpay.test', accessTtlSec: 600, idleSec: 1800, absoluteSec: 28800, clientBind: 'cb', traceId: randomUUID() })
    expect(res.acr).toBe('AAL2')
  })

  it('a re-seed rotates the secret and keeps exactly one active enrollment', async () => {
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    const active = await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })
    expect(active).toBe(1)
  })
})
