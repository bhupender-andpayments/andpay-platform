import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient, type AuthDb } from '../src/index.js'

// Spec 14a Task 3: vendor_operator table + additive principal_type
// discriminator (S23 expand-contract). Asserts real DB state via
// information_schema, not the schema file (D6: existing spec-04/spec-12 rows
// must be byte-unchanged in DATA, so the assertions target the live database).
const url = process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'
let db: AuthDb
beforeAll(() => { db = new PrismaClient({ datasourceUrl: url }) })
afterAll(async () => { await db.$disconnect() })

describe('vendor_operator table (spec 14a task 3)', () => {
  it('exists with the expected columns', async () => {
    const rows = await db.$queryRawUnsafe<{ column_name: string; data_type: string; is_nullable: string }[]>(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'vendor_operator'",
    )
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    expect(byName['id']).toBeDefined()
    expect(byName['vndr_id']).toBeDefined()
    expect(byName['username']).toBeDefined()
    expect(byName['password_hash']).toBeDefined()
    expect(byName['status']).toBeDefined()
    expect(byName['created_by_actor']).toBeDefined()
    expect(byName['created_at']).toBeDefined()
    for (const col of ['id', 'vndr_id', 'username', 'password_hash', 'status', 'created_by_actor', 'created_at']) {
      expect(byName[col]!.is_nullable).toBe('NO')
    }
  })

  it('has a UNIQUE constraint on (vndr_id, username)', async () => {
    const rows = await db.$queryRawUnsafe<{ indexname: string; cols: string[] }[]>(
      `SELECT i.relname AS indexname,
              (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(ix.indkey) k JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k) AS cols
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'auth' AND t.relname = 'vendor_operator' AND ix.indisunique = true AND NOT ix.indisprimary`,
    )
    const found = rows.some((r) => JSON.stringify(r.cols) === JSON.stringify(['username', 'vndr_id']))
    expect(found).toBe(true)
  })

  it('under SET LOCAL ROLE auth_write, INSERT into vendor_operator succeeds', async () => {
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE auth_write')
      const who = await tx.$queryRawUnsafe<{ current_user: string }[]>('SELECT current_user')
      await tx.vendorOperator.create({
        data: {
          id: randomUUID(),
          vndrId: randomUUID(),
          username: `op-${randomUUID()}`,
          passwordHash: 'hash',
          status: 'ACTIVE',
          createdByActor: randomUUID(),
        },
      })
      return who[0]!.current_user
    })
    expect(seen).toBe('auth_write')
  })

  it('the grant exists in the catalog (auth_write has SELECT/INSERT/UPDATE on vendor_operator, no ALTER DEFAULT PRIVILEGES needed)', async () => {
    const rows = await db.$queryRawUnsafe<{ privilege_type: string }[]>(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'auth_write' AND table_schema = 'auth' AND table_name = 'vendor_operator'",
    )
    const privs = rows.map((r) => r.privilege_type).sort()
    expect(privs).toContain('INSERT')
    expect(privs).toContain('UPDATE')
    expect(privs).toContain('SELECT')
  })
})

describe('principal_type discriminator (additive, default internal)', () => {
  for (const table of ['mfa_enrollment', 'refresh_token', 'denylist']) {
    it(`${table} has a principal_type column defaulting 'internal'`, async () => {
      const rows = await db.$queryRawUnsafe<{ column_default: string | null; is_nullable: string }[]>(
        `SELECT column_default, is_nullable FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = '${table}' AND column_name = 'principal_type'`,
      )
      expect(rows.length).toBe(1)
      expect(rows[0]!.is_nullable).toBe('NO')
      expect(rows[0]!.column_default ?? '').toContain('internal')
    })
  }

  it('existing mfa_enrollment rows are unaffected (default backfilled to internal)', async () => {
    const rows = await db.$queryRawUnsafe<{ principal_type: string }[]>(
      "SELECT DISTINCT principal_type FROM auth.mfa_enrollment",
    )
    for (const r of rows) expect(r.principal_type).toBe('internal')
  })
})

describe('mfa_enrollment FK to internal_principal is gone (expand-contract, S23)', () => {
  it('no foreign key constraint from mfa_enrollment to internal_principal', async () => {
    const rows = await db.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'auth' AND t.relname = 'mfa_enrollment' AND c.contype = 'f'`,
    )
    expect(rows.length).toBe(0)
  })
})
