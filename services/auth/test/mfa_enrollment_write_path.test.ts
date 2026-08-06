import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient, type AuthDb } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
beforeAll(() => { db = new PrismaClient({ datasourceUrl: url }) })
afterAll(async () => { await db.$disconnect() })

describe('mfa_enrollment write-path (spec 12 task 1)', () => {
  it('auth_write can INSERT into mfa_enrollment and current_user is auth_write inside the tx', async () => {
    // This used to enroll against `internalPrincipal.findFirst({})`, an
    // ARBITRARY existing principal, which in a shared dev database is the real
    // ops.admin the portal logs in with. It attached a bogus ACTIVE totp row
    // with secretRef 'ref-test' to that account and never removed it. Because
    // resolveActiveFactorSecret picks an active enrollment with findFirst and no
    // ordering, login could then select the bogus row, find no secret under
    // 'ref-test' in real custody, and fail closed: the demo login broke without
    // its principal ever being deleted.
    //
    // mfa_enrollment has no FK to internal_principal (dropped expand-contract,
    // S23 - asserted in vendor-operator-schema.test.ts), so this owns a
    // synthetic principal id and touches no real account.
    const enrollmentId = crypto.randomUUID()
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE auth_write')
      const who = await tx.$queryRawUnsafe<{ current_user: string }[]>('SELECT current_user')
      await tx.mfaEnrollment.create({
        data: { id: enrollmentId, principalId: crypto.randomUUID(), factor: 'totp', secretRef: 'ref-test', status: 'active', enrolledByActor: crypto.randomUUID() },
      })
      return who[0]!.current_user
    })
    expect(seen).toBe('auth_write')
    // auth_write is granted SELECT/INSERT/UPDATE only, so cleanup runs on the
    // normal connection, scoped to this test's own row.
    await db.mfaEnrollment.deleteMany({ where: { id: enrollmentId } })
  })

  it('the grant exists in the catalog (auth_write has INSERT on mfa_enrollment)', async () => {
    const rows = await db.$queryRawUnsafe<{ privilege_type: string }[]>(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'auth_write' AND table_schema = 'auth' AND table_name = 'mfa_enrollment'",
    )
    const privs = rows.map((r) => r.privilege_type).sort()
    expect(privs).toContain('INSERT')
    expect(privs).toContain('UPDATE')
    expect(privs).toContain('SELECT')
  })
})
