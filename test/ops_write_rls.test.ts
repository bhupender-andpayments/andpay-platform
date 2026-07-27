import { describe, it, expect } from 'vitest'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient } from '@andpay/tms-service'

const F_URL = process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const T_URL = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'

describe('10c ops roles and additive columns', () => {
  const fdb = new FulfillmentClient({ datasourceUrl: F_URL })
  const tdb = new TmsClient({ datasourceUrl: T_URL })

  it('creates non-owner ops read roles with no superuser and no bypassrls', async () => {
    const roles = await fdb.$queryRawUnsafe<Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('tms_ops_read','fulfillment_ops_read') ORDER BY rolname`,
    )
    expect(roles.map((r) => r.rolname)).toEqual(['fulfillment_ops_read', 'tms_ops_read'])
    for (const r of roles) {
      expect(r.rolsuper).toBe(false)
      expect(r.rolbypassrls).toBe(false)
      expect(r.rolcanlogin).toBe(false)
    }
  })

  it('grants fulfillment_ops_read SELECT on the ops-readable tables including the exception surfaces', async () => {
    const grants = await fdb.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'fulfillment_ops_read' AND privilege_type = 'SELECT' AND table_schema = 'fulfillment'
       ORDER BY table_name`,
    )
    const names = grants.map((g) => g.table_name)
    expect(names).toEqual(expect.arrayContaining(['shpt', 'shpt_status_event', 'pending_pool_entry', 'batch', 'composed_artifact', 'vndr', 'intake_exception', 'courier_status_exception']))
  })

  it('does NOT grant fulfillment_read (tenant) SELECT on the exception surfaces (check 9 exclusion)', async () => {
    const grants = await fdb.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'fulfillment_read' AND privilege_type = 'SELECT' AND table_schema = 'fulfillment'
       AND table_name IN ('intake_exception','courier_status_exception')`,
    )
    expect(grants).toEqual([])
  })

  it('adds the additive nullable columns', async () => {
    const cols = await fdb.$queryRawUnsafe<Array<{ table_name: string; column_name: string; is_nullable: string }>>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema='fulfillment' AND (
         (table_name='shpt_status_event' AND column_name='override_reason') OR
         (table_name='pending_pool_entry' AND column_name IN ('released_by_actor','released_at')) OR
         (table_name='composed_artifact' AND column_name IN ('superseded_by','superseded_at')) OR
         (table_name IN ('intake_exception','courier_status_exception') AND column_name IN ('resolved_at','resolved_by_actor')))
       ORDER BY table_name, column_name`,
    )
    for (const c of cols) expect(c.is_nullable).toBe('YES')
    expect(cols.length).toBe(9)
    const qcols = await tdb.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema='tms' AND table_name='quarantine_row' AND column_name IN ('resolved_at','resolved_by_actor')`,
    )
    for (const c of qcols) expect(c.is_nullable).toBe('YES')
    expect(qcols.length).toBe(2)
  })
})
