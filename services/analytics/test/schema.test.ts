import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '../generated/client/index.js'

const db = new PrismaClient({ datasourceUrl: process.env.ANALYTICS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics' })
afterAll(async () => { await db.$disconnect() })

describe('analytics role matrix + RLS (check 1 policy, check 19)', () => {
  it('the three roles exist NOLOGIN NOSUPERUSER NOINHERIT no-BYPASSRLS', async () => {
    const rows = await db.$queryRaw<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolinherit: boolean; rolbypassrls: boolean }[]>`
      SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolbypassrls FROM pg_roles
      WHERE rolname IN ('analytics_read','analytics_write','analytics_relay') ORDER BY rolname`
    expect(rows.map(r => r.rolname)).toEqual(['analytics_read','analytics_relay','analytics_write'])
    for (const r of rows) { expect(r.rolcanlogin).toBe(false); expect(r.rolsuper).toBe(false); expect(r.rolinherit).toBe(false); expect(r.rolbypassrls).toBe(false) }
  })
  it('analytics_read has SELECT only on dispatch_row and NO grant on raw_event', async () => {
    const g = await db.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'analytics_read' AND table_schema = 'analytics' ORDER BY table_name, privilege_type`
    expect(g).toEqual([{ table_name: 'dispatch_row', privilege_type: 'SELECT' }])
  })
  it('dispatch_row FORCE RLS with the Q5 restrictive read policy present', async () => {
    const t = await db.$queryRaw<{ relforcerowsecurity: boolean; relrowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'dispatch_row'`
    expect(t[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
    const p = await db.$queryRaw<{ polname: string; qual: string }[]>`
      SELECT polname, pg_get_expr(polqual, polrelid) AS qual FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relname = 'dispatch_row' AND polname = 'dispatch_row_analytics_read'`
    // pg_get_expr normalizes the stored expression and inserts ::text casts, so
    // match the two Q5 branches by their stable tokens rather than a verbatim
    // string. Cross-tenant branch: current_setting('app.cross_tenant') = 'true'.
    expect(p[0]?.qual).toContain("current_setting('app.cross_tenant'")
    expect(p[0]?.qual).toContain("= 'true'")
    // Set-membership branch: program_id = ANY(current_setting('app.program_ids')::uuid[]).
    expect(p[0]?.qual).toContain("program_id = ANY (")
    expect(p[0]?.qual).toContain("current_setting('app.program_ids'")
  })
})
