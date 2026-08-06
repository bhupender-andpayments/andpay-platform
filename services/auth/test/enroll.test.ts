import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { authenticator } from 'otplib'
import { PrismaClient, type AuthDb, enrollTotp, confirmTotpEnrollment, login, LocalEs256Adapter, TotpAdapter } from '../src/index.js'

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

describe('pending-until-confirmed self-enrollment', () => {
  it('leaves the account with NO factor when the QR is displayed but never confirmed', async () => {
    // The lockout bug: displaying the QR used to enroll the account outright,
    // so an operator who opened setup and walked away was left enrolled against
    // a secret nobody held, and every later sign-in demanded a code they could
    // never produce.
    await enrollTotp(db, {
      targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
      issuer: 'AndPay', storeSecret, traceId: randomUUID(),
      requireNoActiveEnrollment: true, pendingUntilConfirmed: true,
    })
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(0)
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'pending' } })).toBe(1)
  })

  it('re-opening setup supersedes the earlier pending attempt instead of piling up', async () => {
    for (let i = 0; i < 3; i += 1) {
      await enrollTotp(db, {
        targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
        issuer: 'AndPay', storeSecret, traceId: randomUUID(),
        requireNoActiveEnrollment: true, pendingUntilConfirmed: true,
      })
    }
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'pending' } })).toBe(1)
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(0)
  })

  it('activates only once a code generated from the pending secret is presented', async () => {
    const { otpauthUri } = await enrollTotp(db, {
      targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
      issuer: 'AndPay', storeSecret, traceId: randomUUID(),
      requireNoActiveEnrollment: true, pendingUntilConfirmed: true,
    })
    const secret = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')!
    const mfa = new TotpAdapter()
    const resolveSecretRef = async (ref: string) => vault.get(ref)

    // A WRONG code changes nothing: still pending, still no factor.
    await expect(
      confirmTotpEnrollment(db, {
        principalId, totp: '000000', resolveSecretRef,
        verify: (a) => mfa.verify(a), traceId: randomUUID(),
      }),
    ).rejects.toThrow()
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(0)

    // The real code promotes it.
    await confirmTotpEnrollment(db, {
      principalId, totp: authenticator.generate(secret), resolveSecretRef,
      verify: (a) => mfa.verify(a), traceId: randomUUID(),
    })
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(1)
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'pending' } })).toBe(0)
  })
})

describe('enrollTotp first-time-only guard (self-enrollment safety)', () => {
  it('refuses to replace an ACTIVE enrollment when requireNoActiveEnrollment is set', async () => {
    // This is the guard that makes password-only self-enrollment safe. Without
    // it, anyone holding the password of an ALREADY-ENROLLED account could mint
    // a new secret and take the account over.
    await enrollTotp(db, {
      targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
      issuer: 'AndPay', storeSecret, traceId: randomUUID(),
    })
    const before = await db.mfaEnrollment.findFirst({ where: { principalId, status: 'active' } })

    await expect(
      enrollTotp(db, {
        targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
        issuer: 'AndPay', storeSecret, traceId: randomUUID(),
        requireNoActiveEnrollment: true,
      }),
    ).rejects.toThrow(/active enrollment already exists/i)

    // The original enrollment is untouched: same row, same secret reference.
    const after = await db.mfaEnrollment.findFirst({ where: { principalId, status: 'active' } })
    expect(after!.id).toBe(before!.id)
    expect(after!.secretRef).toBe(before!.secretRef)
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(1)
  })

  it('allows a FIRST enrollment when requireNoActiveEnrollment is set', async () => {
    const { otpauthUri } = await enrollTotp(db, {
      targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
      issuer: 'AndPay', storeSecret, traceId: randomUUID(),
      requireNoActiveEnrollment: true,
    })
    expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true)
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(1)
  })

  it('still lets an ADMIN re-seed rotate an existing enrollment (no flag set)', async () => {
    await enrollTotp(db, {
      targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
      issuer: 'AndPay', storeSecret, traceId: randomUUID(),
    })
    const first = await db.mfaEnrollment.findFirst({ where: { principalId, status: 'active' } })
    await enrollTotp(db, {
      targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(),
      issuer: 'AndPay', storeSecret, traceId: randomUUID(),
    })
    const second = await db.mfaEnrollment.findFirst({ where: { principalId, status: 'active' } })
    expect(second!.id).not.toBe(first!.id)
    // Exactly one active row survives a rotate.
    expect(await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })).toBe(1)
  })
})

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
    const resolveSecretRef = async (ref: string) => vault.get(ref)
    const totp = authenticator.generate(secret)
    const res = await login(handle, 'pw', totp, { db, signer, mfa: new TotpAdapter(), resolveSecretRef, iss: 'https://auth.andpay.test', accessTtlSec: 600, idleSec: 1800, absoluteSec: 28800, clientBind: 'cb', traceId: randomUUID() })
    expect(res.acr).toBe('AAL2')
  })

  it('a re-seed rotates the secret and keeps exactly one active enrollment', async () => {
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: handle, enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    const active = await db.mfaEnrollment.count({ where: { principalId, status: 'active' } })
    expect(active).toBe(1)
  })
})
