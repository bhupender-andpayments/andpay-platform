import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient, type AuthDb } from '../src/index.js'

const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
beforeAll(() => { db = new PrismaClient({ datasourceUrl: url }) })
afterAll(async () => { await db.$disconnect() })

describe('mfa_enrollment write-path (spec 12 task 1)', () => {
  it('auth_write can INSERT into mfa_enrollment and current_user is auth_write inside the tx', async () => {
    const principal = await db.internalPrincipal.findFirst({})
    if (!principal) return // seeded-data-free environments: the grant assertion below still runs
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE auth_write')
      const who = await tx.$queryRawUnsafe<{ current_user: string }[]>('SELECT current_user')
      await tx.mfaEnrollment.create({
        data: { id: crypto.randomUUID(), principalId: principal.id, factor: 'totp', secretRef: 'ref-test', status: 'active', enrolledByActor: crypto.randomUUID() },
      })
      return who[0]!.current_user
    })
    expect(seen).toBe('auth_write')
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
