import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import { PrismaClient, type AuthDb, login, LocalEs256Adapter, TotpAdapter } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
let signer: LocalEs256Adapter
const handle = `login-audit-${randomUUID()}`
let principalId: string

async function auditRows(pid: string) {
  return db.$queryRawUnsafe<{ payload: { decision: string; operation: string; reasonCode?: string; outcome?: string } }[]>(
    `SELECT payload FROM outbox WHERE event_type = 'authz.audit' AND aggregate_id = '${pid}' ORDER BY created_at ASC`,
  )
}

beforeAll(async () => {
  db = new PrismaClient({ datasourceUrl: url })
  signer = await LocalEs256Adapter.create('login-audit-key')
  principalId = randomUUID()
  const pwHash = await argonHash('correct-horse')
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE auth_write')
    // seed the principal as owner (a raw insert via a nested owner tx is not
    // available here; internal_principal is admin-provisioned. Use a direct
    // create under the base role which owns the schema in dev).
  })
  await db.internalPrincipal.create({ data: { id: principalId, loginHandle: handle, passwordHash: pwHash, status: 'ACTIVE', role: 'admin' } })
})
afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  await db.internalPrincipal.delete({ where: { id: principalId } })
  await db.$disconnect()
})
beforeEach(async () => {
  await db.$executeRawUnsafe(`DELETE FROM refresh_token WHERE principal_id = '${principalId}'`)
  await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = '${principalId}'`)
  // Enrollment state decides which login branch runs, so it must be reset per
  // test like every other row this suite writes.
  await db.$executeRawUnsafe(`DELETE FROM mfa_enrollment WHERE principal_id = '${principalId}'`)
})

const baseDeps = () => ({ db, signer, mfa: new TotpAdapter(), resolveSecretRef: async () => 'JBSWY3DPEHPK3PXP', iss: 'https://auth.andpay.test', accessTtlSec: 600, idleSec: 1800, absoluteSec: 28800, clientBind: 'cb', traceId: randomUUID() })

describe('login 6e audit (spec 12 task 4)', () => {
  it('a wrong password DENIES and commits exactly one DENY audit before throwing', async () => {
    await expect(login(handle, 'wrong', undefined, baseDeps())).rejects.toThrow('authn-failed')
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    expect(rows[0]!.payload.operation).toBe('login')
  })
  it('a wrong TOTP DENIES with a mfa-failed DENY audit before throwing', async () => {
    await expect(login(handle, 'correct-horse', '000000', baseDeps())).rejects.toThrow('mfa-failed')
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    expect(rows[0]!.payload.reasonCode).toBe('mfa-failed')
  })
  it('an unknown handle DENIES authn-failed and audits one DENY under principalId unknown', async () => {
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = 'unknown'`)
    await expect(login(`no-such-${randomUUID()}`, 'whatever', undefined, baseDeps())).rejects.toThrow('authn-failed')
    const rows = await auditRows('unknown')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    await db.$executeRawUnsafe(`DELETE FROM outbox WHERE aggregate_id = 'unknown'`)
  })
  it('password-only on an ENROLLED principal answers mfaRequired and audits nothing', async () => {
    // An ACTIVE enrollment row is what makes the principal already-enrolled, so
    // the first-login self-enrollment path does not apply.
    await db.mfaEnrollment.create({
      data: {
        id: randomUUID(),
        principalId,
        principalType: 'internal',
        factor: 'totp',
        secretRef: 'ref-test',
        status: 'active',
        enrolledByActor: randomUUID(),
      },
    })
    const res = await login(handle, 'correct-horse', undefined, baseDeps())
    expect(res.mfaRequired).toBe(true)
    expect(res.accessToken).toBeUndefined()
    // NO audit row: asking for the second factor is a continuation, not a
    // decision. The previous behaviour wrote an assurance-insufficient DENY on
    // every ordinary sign-in, which buried genuine denials in routine traffic.
    expect(await auditRows(principalId)).toHaveLength(0)
  })

  it('password-only on an UNENROLLED principal audits one enrollment-required ALLOW', async () => {
    const res = await login(handle, 'correct-horse', undefined, baseDeps())
    expect(res.enrollmentRequired).toBe(true)
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('ALLOW')
    expect(rows[0]!.payload.outcome).toBe('enrollment-required')
    // No refresh family is opened on this path.
    expect(await db.refreshToken.count({ where: { principalId } })).toBe(0)
  })
  it('password + a valid TOTP ALLOWs and co-commits exactly one ALLOW audit with the refresh family', async () => {
    // An enrolled principal needs BOTH the active enrollment row and the
    // custody secret: login refuses to verify a factor with no active
    // enrollment behind it, so the row is part of the fixture, not optional.
    await db.mfaEnrollment.create({
      data: {
        id: randomUUID(),
        principalId,
        principalType: 'internal',
        factor: 'totp',
        secretRef: 'ref-test',
        status: 'active',
        enrolledByActor: randomUUID(),
      },
    })
    const { authenticator } = await import('otplib')
    const totp = authenticator.generate('JBSWY3DPEHPK3PXP')
    const res = await login(handle, 'correct-horse', totp, baseDeps())
    expect(res.acr).toBe('AAL2')
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('ALLOW')
    const fam = await db.refreshToken.count({ where: { principalId } })
    expect(fam).toBe(1)
  })
})
