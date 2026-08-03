import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  PrismaClient,
  type AuthDb,
  enrollTotp,
  issueRefreshFamily,
  rotateRefresh,
  logoutByRefreshToken,
} from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb

beforeAll(async () => {
  db = new PrismaClient({ datasourceUrl: url })
})
afterAll(async () => {
  await db.$disconnect()
})

// A stand-in custody vault keyed by BOTH principalId and principalType (spec
// 14a task 5): an internal and a vendor_operator enrollment sharing the SAME
// principalId value must resolve to DISTINCT secrets.
const vault = new Map<string, string>()
const storeSecret = async (pid: string, secret: string, principalType?: string): Promise<string> => {
  const ref = `vault://${pid}:${principalType ?? 'internal'}`
  vault.set(ref, secret)
  return ref
}
const mfaSecretResolver = (principalType: 'internal' | 'vendor_operator') => async (pid: string) =>
  vault.get(`vault://${pid}:${principalType}`)

describe('principal_type generalization: enroll (spec 14a task 5)', () => {
  const principalId = randomUUID()

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_id = '${principalId}'`)
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
    vault.clear()
  })
  afterAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_id = '${principalId}'`)
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  })

  it('an internal enroll (no principalType passed) writes principal_type=internal, byte-unchanged', async () => {
    const { otpauthUri } = await enrollTotp(db, {
      targetPrincipalId: principalId,
      targetAccountLabel: 'handle',
      enrolledByActor: randomUUID(),
      issuer: 'AndPay',
      storeSecret,
      traceId: randomUUID(),
    })
    expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true)
    const row = await db.mfaEnrollment.findFirst({ where: { principalId } })
    expect(row!.principalType).toBe('internal')
    expect(row!.status).toBe('active')
  })

  it('a vendor enroll writes principal_type=vendor_operator with the secret ABSENT from the row', async () => {
    const { otpauthUri } = await enrollTotp(db, {
      targetPrincipalId: principalId,
      targetAccountLabel: 'handle',
      enrolledByActor: randomUUID(),
      issuer: 'AndPay',
      storeSecret,
      principalType: 'vendor_operator',
      traceId: randomUUID(),
    })
    expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true)
    const row = await db.mfaEnrollment.findFirst({ where: { principalId, principalType: 'vendor_operator' } })
    expect(row).not.toBeNull()
    expect(row!.principalType).toBe('vendor_operator')
    expect(row!.status).toBe('active')
    expect(row!.secretRef).toBeTruthy()
    const secretParam = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret')
    expect(JSON.stringify(row)).not.toContain(secretParam)
  })

  it('an internal enroll and a vendor enroll for the SAME principalId are independent active rows', async () => {
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, principalType: 'vendor_operator', traceId: randomUUID() })
    const internalActive = await db.mfaEnrollment.count({ where: { principalId, principalType: 'internal', status: 'active' } })
    const vendorActive = await db.mfaEnrollment.count({ where: { principalId, principalType: 'vendor_operator', status: 'active' } })
    expect(internalActive).toBe(1)
    expect(vendorActive).toBe(1)
  })

  it('a re-seed of the vendor enrollment rotates only the vendor row, leaving the internal row untouched', async () => {
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, principalType: 'vendor_operator', traceId: randomUUID() })
    await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, principalType: 'vendor_operator', traceId: randomUUID() })
    const internalActive = await db.mfaEnrollment.count({ where: { principalId, principalType: 'internal', status: 'active' } })
    const vendorActive = await db.mfaEnrollment.count({ where: { principalId, principalType: 'vendor_operator', status: 'active' } })
    const vendorTotal = await db.mfaEnrollment.count({ where: { principalId, principalType: 'vendor_operator' } })
    expect(internalActive).toBe(1)
    expect(vendorActive).toBe(1)
    expect(vendorTotal).toBe(2) // one revoked, one active
  })

  it('mfaSecretResolver returns DISTINCT secrets for (principalId, internal) vs (principalId, vendor_operator)', async () => {
    const { otpauthUri: internalUri } = await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, traceId: randomUUID() })
    const { otpauthUri: vendorUri } = await enrollTotp(db, { targetPrincipalId: principalId, targetAccountLabel: 'handle', enrolledByActor: randomUUID(), issuer: 'AndPay', storeSecret, principalType: 'vendor_operator', traceId: randomUUID() })
    const internalSecret = new URL(internalUri.replace('otpauth://', 'https://')).searchParams.get('secret')
    const vendorSecret = new URL(vendorUri.replace('otpauth://', 'https://')).searchParams.get('secret')
    expect(internalSecret).not.toBe(vendorSecret)
    const resolvedInternal = await mfaSecretResolver('internal')(principalId)
    const resolvedVendor = await mfaSecretResolver('vendor_operator')(principalId)
    expect(resolvedInternal).toBe(internalSecret)
    expect(resolvedVendor).toBe(vendorSecret)
    expect(resolvedInternal).not.toBe(resolvedVendor)
  })
})

describe('principal_type generalization: refresh family disjointness (spec 14a task 5)', () => {
  const principalId = randomUUID()

  beforeEach(async () => {
    await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  })
  afterAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  })

  it('an internal family issued with no principalType writes principal_type=internal, byte-unchanged', async () => {
    const { refreshToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 })
    const row = await db.refreshToken.findFirst({ where: { principalId, tokenHash: { not: undefined } } })
    expect(row).not.toBeNull()
    expect(row!.principalType).toBe('internal')
    // sanity: the returned token still rotates normally
    const { refreshToken: r1 } = await rotateRefresh(refreshToken, { db, idleSec: 1800, now: 1100 })
    expect(r1).not.toBe(refreshToken)
  })

  it('a vendor family and an internal family with the SAME principalId are DISJOINT: logging out the vendor family leaves the internal family live', async () => {
    const { refreshToken: internalToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 }, 'internal')
    const { refreshToken: vendorToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 }, 'vendor_operator')

    await logoutByRefreshToken(db, vendorToken, randomUUID(), 'vendor_operator')

    // The vendor family is now dead.
    await expect(rotateRefresh(vendorToken, { db, idleSec: 1800, now: 1100, principalType: 'vendor_operator' })).rejects.toThrow()
    // The internal family, sharing the SAME principalId, is untouched and rotates fine.
    const { refreshToken: r1 } = await rotateRefresh(internalToken, { db, idleSec: 1800, now: 1100, principalType: 'internal' })
    expect(r1).not.toBe(internalToken)
  })

  it('the reverse direction also holds: logging out the internal family leaves the vendor family live', async () => {
    const { refreshToken: internalToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 }, 'internal')
    const { refreshToken: vendorToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 }, 'vendor_operator')

    await logoutByRefreshToken(db, internalToken, randomUUID(), 'internal')

    await expect(rotateRefresh(internalToken, { db, idleSec: 1800, now: 1100, principalType: 'internal' })).rejects.toThrow()
    const { refreshToken: r1 } = await rotateRefresh(vendorToken, { db, idleSec: 1800, now: 1100, principalType: 'vendor_operator' })
    expect(r1).not.toBe(vendorToken)
  })

  it('rotateRefresh rejects a token whose row principal_type does not match the asserted principalType', async () => {
    const { refreshToken: vendorToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 }, 'vendor_operator')
    // Asserting 'internal' against a vendor-typed token must be rejected, not silently accepted.
    await expect(rotateRefresh(vendorToken, { db, idleSec: 1800, now: 1100, principalType: 'internal' })).rejects.toThrow()
  })

  it('a rotated successor token inherits the family principal_type', async () => {
    const { refreshToken: vendorToken } = await issueRefreshFamily(principalId, 'client-A', { db, idleSec: 1800, absoluteSec: 28800, now: 1000 }, 'vendor_operator')
    const { refreshToken: r1 } = await rotateRefresh(vendorToken, { db, idleSec: 1800, now: 1100, principalType: 'vendor_operator' })
    const row = await db.refreshToken.findFirst({ where: { principalId, principalType: 'vendor_operator', used: false, revoked: false } })
    expect(row).not.toBeNull()
    expect(row!.principalType).toBe('vendor_operator')
    void r1
  })
})
