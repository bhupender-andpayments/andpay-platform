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
  return db.$queryRawUnsafe<{ payload: { decision: string; operation: string; reasonCode?: string } }[]>(
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
})

const baseDeps = () => ({ db, signer, mfa: new TotpAdapter(), mfaSecretResolver: async () => 'JBSWY3DPEHPK3PXP', iss: 'https://auth.andpay.test', accessTtlSec: 600, idleSec: 1800, absoluteSec: 28800, clientBind: 'cb', traceId: randomUUID() })

describe('login 6e audit (spec 12 task 4)', () => {
  it('a wrong password DENIES and commits exactly one DENY audit before throwing', async () => {
    await expect(login(handle, 'wrong', undefined, baseDeps())).rejects.toThrow('authn-failed')
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    expect(rows[0]!.payload.operation).toBe('login')
  })
  it('password-only DENIES against the AAL2 floor with an assurance-insufficient DENY audit', async () => {
    await expect(login(handle, 'correct-horse', undefined, baseDeps())).rejects.toThrow('assurance-insufficient')
    const rows = await auditRows(principalId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload.decision).toBe('DENY')
    expect(rows[0]!.payload.reasonCode).toBe('assurance-insufficient')
  })
  it('password + a valid TOTP ALLOWs and co-commits exactly one ALLOW audit with the refresh family', async () => {
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
