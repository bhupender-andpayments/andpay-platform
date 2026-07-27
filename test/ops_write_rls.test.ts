import { describe, it, expect, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
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

// LOAD-BEARING (Task 4): proves the write-gate actually bites once a later
// ops API runs a domain effect under fulfillment_write with a server-resolved
// SET LOCAL app.program_id. Seeding is done as fdb's default connection,
// andpay, which is the Postgres CLUSTER SUPERUSER (POSTGRES_USER in
// infra/docker-compose.dev.yml): a superuser bypasses RLS even under FORCE
// ROW LEVEL SECURITY (a mere table owner does NOT bypass FORCE RLS). The
// UPDATE attempt under fulfillment_write is a DIFFERENT connection scope
// entirely (SET LOCAL ROLE is transaction-scoped), so it is subject to the
// shpt_scoped permissive policy's WITH CHECK (program_id =
// current_setting('app.program_id')::uuid).
describe('10c ops write bites under fulfillment_write with per-action scope', () => {
  const fdb = new FulfillmentClient({ datasourceUrl: F_URL })

  const A = '11111111-1111-1111-1111-111111111111'
  const B = '22222222-2222-2222-2222-222222222222'
  const shptId = toUuid(newId('shpt'))
  const awb = `AWB-10c-write-rls-${shptId}`
  const tenantId = toUuid(newId('tnnt'))

  async function seedShipment(): Promise<void> {
    await fdb.$executeRawUnsafe(
      `INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
       VALUES ('${shptId}'::uuid, '${awb}', 'DISPATCHED_BY_VENDOR', now(), '${tenantId}'::uuid, '${A}'::uuid, now())`,
    )
  }

  async function cleanup(): Promise<void> {
    await fdb.$executeRawUnsafe(`DELETE FROM shpt WHERE id = '${shptId}'::uuid`)
  }

  afterAll(async () => {
    await cleanup()
    await fdb.$disconnect()
  })

  it('rejects a write whose SET LOCAL app.program_id differs from the row program (WITH CHECK)', async () => {
    await cleanup()
    await seedShipment()

    // Seed a shpt row as owner in program A, then attempt an UPDATE under
    // fulfillment_write with app.program_id = program B: WITH CHECK must reject.
    await expect(
      fdb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_write`)
        await tx.$queryRaw`SELECT set_config('app.program_id', ${B}, true)`
        await tx.$executeRawUnsafe(`UPDATE shpt SET status='PICKED_UP', updated_at=now() WHERE program_id = '${A}'::uuid`)
      }),
    ).rejects.toThrow(/row-level security|new row violates|WITH CHECK/i)

    await cleanup()
  })

  it('confirms fulfillment_write is not owner and has no bypassrls', async () => {
    const r = await fdb.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='fulfillment_write'`,
    )
    expect(r[0]!.rolsuper).toBe(false)
    expect(r[0]!.rolbypassrls).toBe(false)
  })
})
