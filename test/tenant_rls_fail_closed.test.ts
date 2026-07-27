import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient as TmsClient } from '@andpay/tms-service'
import { PrismaClient as FulfillmentClient } from '@andpay/fulfillment-service'

// Root-only integration seam (this file is under test/, not services/<ctx>, so
// the cross-schema guard test/architecture.test.ts never scans it). It is the
// ONE place allowed to name both tms. and fulfillment. schemas, which the
// cross-schema-denial check (check 2) needs on purpose.
//
// LOAD-BEARING behavioral RLS proof for spec 10b, Task 2 (checks 1, 2, 5, 11):
//   - check 1: the RESTRICTIVE tenant-read policy is the backstop. Under
//     <ctx>_read with app.program_ids = '{A}', a raw SELECT with NO program
//     predicate returns ONLY program A rows (the app predicate is deliberately
//     absent, so RLS alone is doing the work).
//   - check 5: app.program_ids = '{A,C}' returns A and C, excludes B (set
//     membership via = ANY, the read key app.program_ids is an array, distinct
//     from the scalar write key app.program_id).
//   - check 2: a fully-qualified cross-schema SELECT under a context read role
//     is rejected with permission denied (no USAGE on the other schema).
//   - check 11: has_table_privilege for the read role is SELECT true, INSERT
//     false; the tables FORCE row level security and the read role is not owner.
//
// CRITICAL: every connection is Postgres user andpay, the container superuser
// and table owner, which BYPASSES RLS entirely. RLS only bites once the tx does
// SET LOCAL ROLE <ctx>_read (a non-superuser, non-owner role). Seeding is done
// as andpay OUTSIDE the read-role transaction (full privilege, RLS bypass).
const tmsUrl = process.env.TMS_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const fulfillmentUrl =
  process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const tms = new TmsClient({ datasourceUrl: tmsUrl })
const fulfillment = new FulfillmentClient({ datasourceUrl: fulfillmentUrl })

// Three distinct Program ids. A and C are entitled, B is the excluded tenant.
const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'
const PROGRAMS = [A, B, C] as const

// A uuid[] literal for a set of programs, e.g. '{A,C}'.
function set(...ids: string[]): string {
  return `{${ids.join(',')}}`
}

// Run a read as a context role inside ONE transaction: SET LOCAL ROLE (tx
// scoped, auto-reset on commit), set_config app.program_ids (is_local = true),
// then the caller's raw SELECT. This is what makes RLS actually bite.
async function readAs<T = Record<string, unknown>>(
  db: TmsClient | FulfillmentClient,
  role: string,
  programIds: string | null,
  sql: string,
): Promise<T[]> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
    if (programIds !== null) {
      await tx.$executeRawUnsafe(`SELECT set_config('app.program_ids', '${programIds}', true)`)
    }
    return tx.$queryRawUnsafe<T[]>(sql)
  })
}

async function seed(): Promise<void> {
  for (const p of PROGRAMS) {
    const tenantId = randomUUID()
    await tms.$executeRawUnsafe(
      `INSERT INTO assignment (id, merchant_id, program_id, tenant_id, merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, soundbox, standee_count, sticker_count, billable, demand_state, source_event_id, updated_at)
       VALUES ('${randomUUID()}', '${randomUUID()}', '${p}', '${tenantId}', 'Disp', 'Legal Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'addr', 'qr', 'vpa', true, 1, 1, true, 'received', 'rls-test-${randomUUID()}', now())`,
    )
    await fulfillment.$executeRawUnsafe(
      `INSERT INTO pending_pool_entry (asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable, merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name, ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, updated_at)
       VALUES ('${randomUUID()}', '${tenantId}', '${p}', true, 1, 1, true, 'Disp', 'Legal Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', 'addr', 'qr', 'vpa', 'POOLED', 'rls-test-${randomUUID()}', 'trace-rls', now())`,
    )
    await fulfillment.$executeRawUnsafe(
      `INSERT INTO batch (id, tenant_id, program_id, status, trigger_reason, unit_count, updated_at)
       VALUES ('${randomUUID()}', '${tenantId}', '${p}', 'BORN', 'MANUAL', 1, now())`,
    )
    await fulfillment.$executeRawUnsafe(
      `INSERT INTO composed_artifact (asgn_id, btch_id, tenant_id, program_id, artifact_type, asset_reference, label_display_name, label_qr)
       VALUES ('${randomUUID()}', '${randomUUID()}', '${tenantId}', '${p}', 'SOUNDBOX_IMG', 'ref', 'Disp', 'qr')`,
    )
    await fulfillment.$executeRawUnsafe(
      `INSERT INTO shpt (id, awb, status, dispatch_date, tenant_id, program_id, updated_at)
       VALUES ('${randomUUID()}', 'AWB-rls-${randomUUID()}', 'DISPATCHED_BY_VENDOR', now(), '${tenantId}', '${p}', now())`,
    )
    await fulfillment.$executeRawUnsafe(
      `INSERT INTO shpt_status_event (shpt_id, program_id, status, courier_timestamp, status_source, source_ref, trace_id)
       VALUES ('${randomUUID()}', '${p}', 'PICKED_UP', now(), 'WEBHOOK', 'ref-${randomUUID()}', 'trace-rls')`,
    )
  }
}

async function cleanup(): Promise<void> {
  const inList = `('${A}','${B}','${C}')`
  await tms.$executeRawUnsafe(`DELETE FROM assignment WHERE program_id IN ${inList}`)
  await fulfillment.$executeRawUnsafe(`DELETE FROM shpt_status_event WHERE program_id IN ${inList}`)
  await fulfillment.$executeRawUnsafe(`DELETE FROM shpt WHERE program_id IN ${inList}`)
  await fulfillment.$executeRawUnsafe(`DELETE FROM composed_artifact WHERE program_id IN ${inList}`)
  await fulfillment.$executeRawUnsafe(`DELETE FROM batch WHERE program_id IN ${inList}`)
  await fulfillment.$executeRawUnsafe(`DELETE FROM pending_pool_entry WHERE program_id IN ${inList}`)
}

beforeAll(async () => {
  await cleanup()
  await seed()
})
afterAll(async () => {
  await cleanup()
  await tms.$disconnect()
  await fulfillment.$disconnect()
})

// The five fulfillment tables that carry a _tenant_read restrictive policy and
// which read role reads them.
const FULFILLMENT_READ_TABLES = [
  'pending_pool_entry',
  'batch',
  'composed_artifact',
  'shpt',
  'shpt_status_event',
] as const

describe('Task 2 tenant READ RLS: restrictive set-membership predicate + per-context role matrix (checks 1, 2, 5, 11)', () => {
  it('check 1 (RLS backstop, tms): under tms_read with app.program_ids={A} and NO app predicate, assignment returns only program A rows', async () => {
    const rows = await readAs<{ program_id: string }>(tms, 'tms_read', set(A), 'SELECT program_id FROM assignment')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.program_id === A)).toBe(true)
  })

  it('check 1 (RLS backstop, fulfillment): under fulfillment_read with app.program_ids={A} and NO app predicate, every program-scoped table returns only program A rows', async () => {
    for (const table of FULFILLMENT_READ_TABLES) {
      const rows = await readAs<{ program_id: string }>(
        fulfillment,
        'fulfillment_read',
        set(A),
        `SELECT program_id FROM ${table}`,
      )
      expect(rows.length, `${table} should return at least the program A row`).toBeGreaterThan(0)
      expect(rows.every((r) => r.program_id === A), `${table} leaked a non-A row`).toBe(true)
    }
  })

  it('check 1 fail-closed (unset): under fulfillment_read with app.program_ids UNSET, shpt leaks NO rows (fresh session: current_setting NULL, row hidden; pooled session where the placeholder reverted to empty string: the query errors on the malformed array). Either manifestation is fail closed, and the error, when one is thrown, MUST be the expected malformed-array cast (Postgres SQLSTATE 22P02); any other error is a real failure, not a fail-closed pass.', async () => {
    let leaked: { program_id: string }[]
    try {
      leaked = await readAs<{ program_id: string }>(fulfillment, 'fulfillment_read', null, 'SELECT program_id FROM shpt')
    } catch (err) {
      // An unusable app.program_ids (empty-string placeholder) errors the SELECT
      // rather than returning rows. No data leaves the database, which is fail
      // closed, BUT only if this is actually that error: a bare catch-all would
      // also swallow an unrelated failure (a typo'd role, a dropped connection,
      // a renamed role) and misreport it as a fail-closed pass. Assert the
      // caught error is the malformed-array-literal cast error: Prisma surfaces
      // the underlying Postgres SQLSTATE as err.meta.code, and the message
      // always contains "malformed array literal" (case-insensitive fallback
      // for whatever Prisma version/shape carries the code).
      const meta = (err as { meta?: { code?: string; message?: string } }).meta
      const sqlstate = meta?.code
      const pgMessage = meta?.message ?? ''
      const message = (err as Error).message ?? ''
      const isMalformedArrayCast =
        sqlstate === '22P02' || /malformed array literal/i.test(pgMessage) || /malformed array literal/i.test(message)
      expect(
        isMalformedArrayCast,
        `expected the malformed-array cast error (SQLSTATE 22P02), got: ${sqlstate ?? 'no sqlstate'} / ${message || pgMessage}`,
      ).toBe(true)
      leaked = []
    }
    expect(leaked.length).toBe(0)
  })

  it('check 1 fail-closed (empty entitlement): under fulfillment_read with app.program_ids={} (entitled to no program), shpt deterministically returns zero rows (program_id = ANY({}) is false for every row)', async () => {
    const rows = await readAs<{ program_id: string }>(fulfillment, 'fulfillment_read', set(), 'SELECT program_id FROM shpt')
    expect(rows.length).toBe(0)
  })

  it('check 5 (set membership): under fulfillment_read with app.program_ids={A,C}, shpt returns A and C and excludes B', async () => {
    const rows = await readAs<{ program_id: string }>(
      fulfillment,
      'fulfillment_read',
      set(A, C),
      'SELECT DISTINCT program_id FROM shpt',
    )
    const seen = rows.map((r) => r.program_id).sort()
    expect(seen).toEqual([A, C].sort())
    expect(seen).not.toContain(B)
  })

  it('check 2 (cross-schema denial): under fulfillment_read, a qualified SELECT FROM tms.assignment is rejected with permission denied', async () => {
    await expect(
      fulfillment.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_read`)
        return tx.$queryRawUnsafe(`SELECT id FROM tms."assignment" LIMIT 1`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('check 2 (cross-schema denial, symmetric): under tms_read, a qualified SELECT FROM fulfillment.shpt is rejected with permission denied', async () => {
    await expect(
      tms.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE tms_read`)
        return tx.$queryRawUnsafe(`SELECT id FROM fulfillment."shpt" LIMIT 1`)
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('07.B (transaction-scope reset): after a transaction that SET LOCAL ROLE fulfillment_read + set_config app.program_ids COMMITS, a fresh transaction on the same client with NO SET sees the scope reset (current_setting NULL, role reset off fulfillment_read, and full cross-tenant visibility)', async () => {
    // First transaction: scope down to program A only under fulfillment_read,
    // confirm the scoping actually bites, then COMMIT (not rollback) so the
    // property under test is specifically "reset on commit", not "reset on
    // rollback" (which would be a weaker, less interesting guarantee).
    await fulfillment.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE fulfillment_read`)
      await tx.$executeRawUnsafe(`SELECT set_config('app.program_ids', '${set(A)}', true)`)
      const rows = await tx.$queryRawUnsafe<{ program_id: string }[]>('SELECT program_id FROM shpt')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.program_id === A)).toBe(true)
    })

    // Second, FRESH transaction on the same client, with NO SET LOCAL ROLE and
    // NO set_config at all. SET LOCAL and set_config(..., true) are both
    // transaction-local (07.B): committing the prior transaction resets both
    // deterministically, rather than leaking into this one because of
    // incidental test ordering or connection pooling.
    await fulfillment.$transaction(async (tx) => {
      const settingRows = await tx.$queryRawUnsafe<{ setting: string | null }[]>(
        `SELECT current_setting('app.program_ids', true) AS setting`,
      )
      const setting = settingRows[0]!.setting
      expect(setting === null || setting === '', `app.program_ids must have reset, got: ${String(setting)}`).toBe(
        true,
      )

      const roleRows = await tx.$queryRawUnsafe<{ role: string }[]>(`SELECT current_user AS role`)
      expect(roleRows[0]!.role, 'the role must have reset off fulfillment_read').not.toBe('fulfillment_read')

      // A plain query, now running as the owning superuser (RLS bypassed
      // entirely) with no read-role restriction in effect, sees ALL three
      // seeded programs: full cross-tenant visibility, proving the prior
      // scope-down did not leak into this transaction. Filtered to the three
      // seeded program ids so unrelated rows left by other test files do not
      // make this assertion depend on suite-wide isolation.
      const rows = await tx.$queryRawUnsafe<{ program_id: string }[]>(
        `SELECT DISTINCT program_id FROM shpt WHERE program_id IN ('${A}','${B}','${C}')`,
      )
      const seen = rows.map((r) => r.program_id).sort()
      expect(seen).toEqual([A, B, C].sort())
    })
  })

  it('check 11 (least privilege): fulfillment_read has SELECT true and INSERT false on fulfillment.shpt', async () => {
    const rows = await fulfillment.$queryRawUnsafe<{ sel: boolean; ins: boolean }[]>(
      `SELECT has_table_privilege('fulfillment_read','fulfillment.shpt','SELECT') AS sel,
              has_table_privilege('fulfillment_read','fulfillment.shpt','INSERT') AS ins`,
    )
    expect(rows[0]!.sel).toBe(true)
    expect(rows[0]!.ins).toBe(false)
  })

  it('check 11 (write role): fulfillment_write has SELECT and INSERT true on fulfillment.shpt', async () => {
    const rows = await fulfillment.$queryRawUnsafe<{ sel: boolean; ins: boolean }[]>(
      `SELECT has_table_privilege('fulfillment_write','fulfillment.shpt','SELECT') AS sel,
              has_table_privilege('fulfillment_write','fulfillment.shpt','INSERT') AS ins`,
    )
    expect(rows[0]!.sel).toBe(true)
    expect(rows[0]!.ins).toBe(true)
  })

  it('catalog: every fulfillment read table FORCEs row level security and its owner is not the read role', async () => {
    for (const table of FULFILLMENT_READ_TABLES) {
      const rows = await fulfillment.$queryRawUnsafe<{ force: boolean; owner: string }[]>(
        `SELECT c.relforcerowsecurity AS force, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'fulfillment' AND c.relname = '${table}'`,
      )
      expect(rows[0]!.force, `${table} must FORCE row level security`).toBe(true)
      expect(rows[0]!.owner, `${table} owner must not be the read role`).not.toBe('fulfillment_read')
    }
  })

  // Fix 1 / Fix 4 regression (S13 least privilege): the read roles were
  // originally granted SELECT ON ALL TABLES IN SCHEMA, which let them read
  // cross-tenant RLS-ungated rows from tables with no restrictive read
  // policy, including the peppered-hash credential_projection and the
  // internal outbox/saga surfaces. A follow-up migration
  // (20260727000200_tighten_read_grants for fulfillment,
  // 20260727000010_tighten_read_grants for tms) revokes the broad grant and
  // re-grants SELECT on ONLY the tenant-facing tables. These assertions prove
  // that narrowing directly: they FAIL against the broad grant and PASS once
  // the tightening migration is applied.
  const FULFILLMENT_NON_TENANT_TABLES = ['credential_projection', 'outbox', 'saga_instance', 'unit', 'vndr'] as const

  it('least privilege (fulfillment): fulfillment_read has NO SELECT on non-tenant-facing tables (credential_projection, outbox, saga_instance, unit, vndr)', async () => {
    for (const table of FULFILLMENT_NON_TENANT_TABLES) {
      const rows = await fulfillment.$queryRawUnsafe<{ sel: boolean }[]>(
        `SELECT has_table_privilege('fulfillment_read', 'fulfillment.${table}', 'SELECT') AS sel`,
      )
      expect(rows[0]!.sel, `fulfillment_read must NOT have SELECT on ${table}`).toBe(false)
    }
  })

  it('least privilege (fulfillment): fulfillment_read has SELECT on all five tenant-facing tables', async () => {
    for (const table of FULFILLMENT_READ_TABLES) {
      const rows = await fulfillment.$queryRawUnsafe<{ sel: boolean }[]>(
        `SELECT has_table_privilege('fulfillment_read', 'fulfillment.${table}', 'SELECT') AS sel`,
      )
      expect(rows[0]!.sel, `fulfillment_read must have SELECT on ${table}`).toBe(true)
    }
  })

  it('least privilege (tms symmetry): tms_read has SELECT on assignment and NO SELECT on merchant_projection', async () => {
    const rows = await tms.$queryRawUnsafe<{ sel_assignment: boolean; sel_merchant: boolean }[]>(
      `SELECT has_table_privilege('tms_read', 'tms.assignment', 'SELECT') AS sel_assignment,
              has_table_privilege('tms_read', 'tms.merchant_projection', 'SELECT') AS sel_merchant`,
    )
    expect(rows[0]!.sel_assignment, 'tms_read must have SELECT on assignment').toBe(true)
    expect(rows[0]!.sel_merchant, 'tms_read must NOT have SELECT on merchant_projection').toBe(false)
  })

  it('check 11 (least privilege, tms symmetry): tms_read has SELECT true and INSERT false on tms.assignment', async () => {
    const rows = await tms.$queryRawUnsafe<{ sel: boolean; ins: boolean }[]>(
      `SELECT has_table_privilege('tms_read','tms.assignment','SELECT') AS sel,
              has_table_privilege('tms_read','tms.assignment','INSERT') AS ins`,
    )
    expect(rows[0]!.sel).toBe(true)
    expect(rows[0]!.ins).toBe(false)
  })

  it('catalog (tms symmetry): tms.assignment FORCEs row level security and its owner is not the read role', async () => {
    const rows = await tms.$queryRawUnsafe<{ force: boolean; owner: string }[]>(
      `SELECT c.relforcerowsecurity AS force, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'tms' AND c.relname = 'assignment'`,
    )
    expect(rows[0]!.force, 'assignment must FORCE row level security').toBe(true)
    expect(rows[0]!.owner, 'assignment owner must not be the read role').not.toBe('tms_read')
  })
})
