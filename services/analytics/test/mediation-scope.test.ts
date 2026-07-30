import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { enterAnalyticsReadScope } from '../src/read-context.js'
import type { ReadScope } from '../src/read-context.js'

// The load-bearing check-1 proof of the Q5 ruling: the single non-owner
// analytics_read role, the discriminated ReadScope, and the RLS backstop.
//
// Harness note (identical to ingest/project tests): the andpay connection is
// the cluster SUPERUSER, which bypasses RLS by status alone. The Q5 policy and
// the analytics_read grant boundary only bite once SET LOCAL ROLE
// analytics_read is in force inside the tx (current_user, not session_user,
// drives the check, and analytics_read is NOSUPERUSER, never a table owner, no
// BYPASSRLS). SET LOCAL is transaction-scoped, so each assertion runs in its
// OWN transaction and the role/GUCs reset at commit. This is what makes every
// proof below NON-VACUOUS: without the role, the superuser would see all rows.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

interface Seeded {
  p1: string
  p2: string
}

// Seed one dispatch_row per program (P1, P2), inserted as the OWNER (the
// superuser connection, no role entered), all NOT NULL columns populated. This
// is the cross-program modeled layer the mediation reads through analytics_read.
async function seed(): Promise<Seeded> {
  const p1 = toUuid(newId('prog'))
  const p2 = toUuid(newId('prog'))
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, updated_at)
    VALUES (${newId('asgn')}, ${p1}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
            'RECEIVED', true, now(), now())`
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, updated_at)
    VALUES (${newId('asgn')}, ${p2}::uuid, 'ICIC', 'ICICI Bank', 'Globex', ARRAY['DEV2']::text[],
            'RECEIVED', true, now(), now())`
  return { p1, p2 }
}

// Enter the given scope and run an UNFILTERED SELECT (no application WHERE
// clause): whatever rows come back are gated by the Q5 RLS policy ALONE. This
// is deliberately the RLS-backstop read, so the own/crossTenant assertions and
// the backstop assertion are one and the same proof: the RLS policy, not an
// application predicate, is what limits the result.
async function selectUnderScope(scope: ReadScope): Promise<string[]> {
  const rows = await db.$transaction(async (tx) => {
    await enterAnalyticsReadScope(tx, scope)
    return tx.$queryRaw<{ program_id: string }[]>`
      SELECT program_id::text AS program_id FROM dispatch_row`
  })
  return rows.map((r) => r.program_id)
}

function distinct(programs: string[]): string[] {
  return [...new Set(programs)]
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE analytics.dispatch_row CASCADE')
})

describe('Q5 mediation scope guardrails: single analytics_read role, discriminated ReadScope, RLS backstop (check 1)', () => {
  it('G1/own: a class-2 own-scope sees ONLY its program_ids; the other program is hidden', async () => {
    const { p1 } = await seed()
    const programs = await selectUnderScope({ kind: 'own', programIds: [p1] })
    expect(distinct(programs)).toEqual([p1]) // P2 hidden by RLS
  })

  it('G1/crossTenant: a class-3 ops crossTenant scope sees BOTH programs', async () => {
    const { p1, p2 } = await seed()
    const programs = await selectUnderScope({ kind: 'crossTenant' })
    expect(distinct(programs).sort()).toEqual([p1, p2].sort())
  })

  it('G2/fail-closed: under analytics_read with NEITHER GUC set, a SELECT returns 0 rows (never all)', async () => {
    await seed()
    const rows = await db.$transaction(async (tx) => {
      // role only: no app.program_ids, no app.cross_tenant. The RESTRICTIVE Q5
      // policy evaluates cross_tenant NULL <> 'true' and program_id = ANY(NULL)
      // NULL, so no row satisfies it: the mediation miss fails CLOSED.
      await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_read')
      return tx.$queryRaw<{ dispatch_id: string }[]>`SELECT dispatch_id FROM dispatch_row`
    })
    expect(rows).toHaveLength(0)
  })

  it('G2/backstop: with the application predicate REMOVED, RLS alone still limits a class-2 to its own programs', async () => {
    const { p1 } = await seed()
    // Enter own-scope P1, then run an UNFILTERED SELECT (no WHERE program_id):
    // the only thing that can limit this to P1 is the RLS policy itself.
    const rows = await db.$transaction(async (tx) => {
      await enterAnalyticsReadScope(tx, { kind: 'own', programIds: [p1] })
      return tx.$queryRaw<{ program_id: string }[]>`
        SELECT program_id::text AS program_id FROM dispatch_row`
    })
    expect(distinct(rows.map((r) => r.program_id))).toEqual([p1])
  })

  it('G1/isolation: a class-2 own-scope call can NEVER set cross_tenant (structural: kind own has no path to app.cross_tenant)', async () => {
    await seed()
    const ct = await db.$transaction(async (tx) => {
      await enterAnalyticsReadScope(tx, { kind: 'own', programIds: [toUuid(newId('prog'))] })
      const rows = await tx.$queryRaw<{ ct: string | null }[]>`
        SELECT current_setting('app.cross_tenant', true) AS ct`
      return rows[0]!.ct
    })
    // own scope has no code path that sets app.cross_tenant: it stays unset.
    expect(ct === null || ct === '').toBe(true)
    expect(ct).not.toBe('true')
  })

  it('analytics_read is not the owner and cannot write: INSERT under the role is permission denied', async () => {
    const { p1 } = await seed()
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_read')
        await tx.$executeRaw`
          INSERT INTO dispatch_row
            (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
             pipeline_state, billable_flag, received_at, updated_at)
          VALUES (${newId('asgn')}, ${p1}::uuid, 'HDFC', 'HDFC Bank', 'Acme', ARRAY['DEV1']::text[],
                  'RECEIVED', true, now(), now())`
      }),
    ).rejects.toThrow(/permission denied/)
  })
})
