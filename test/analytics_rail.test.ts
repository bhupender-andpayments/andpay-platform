import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { relayOnce, InMemoryPublisher, type OutboxClient } from '@andpay/outbox'
import type { AuthzAuditRecord } from '@andpay/audit'
import { PrismaClient as AnalyticsClient, emitAnalyticsReadAudit } from '@andpay/analytics-service'
import {
  PrismaClient as AuthClient,
  consumeAuthzAudit,
  verifyAuthzChain,
  AUTHZ_AUDIT_CONSUMER,
  type AuthDb,
} from '@andpay/auth-service'

/**
 * C4 fact-consumer isolation guard for the S19 analytics rail (spec 11, D98,
 * check 2). Runs with no database.
 *
 * The analytics rail integrates with the TMS/Fulfillment/Identity/Auth/Orchestrator contexts
 * ONLY through consumed fct.* facts and the facts' OWN carried snapshots, never
 * a read into another context's schema and never an import of another context's
 * source or generated client (C4, T7). The nine subscribed topics and the nine
 * fact payload shapes are declared LOCAL (own-copy) in services/analytics/src;
 * this is a STATIC net over that source asserting the boundary holds. It models
 * the precise patterns of test/architecture.test.ts checks C (schema-qualified)
 * and D (source import): a bare context word inside a topic string like
 * 'fct.tms.assignment.v1' is NOT a cross-schema read, and a comment mentioning a
 * context by name (services/tms, no trailing slash) is NOT an import, so both
 * legitimately survive the guard while a real breach does not.
 *
 * Plant-and-remove recipe (to prove this guard bites): add a line such as
 *   import { AssignmentFactPayload } from '@andpay/tms-service'
 * (or a raw read `FROM tms.raw_event`) to any file under services/analytics/src.
 * Run `pnpm exec vitest run test/analytics_rail.test.ts`: this block fails.
 * Remove the planted line: it passes again.
 */

const root = process.cwd()
const OTHER_CONTEXTS = ['tms', 'fulfillment', 'identity', 'auth', 'orchestrator'] as const

function walk(rel: string): string[] {
  const base = join(root, rel)
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true })
    .map((p) => join(rel, p.toString()))
    .filter((p) => !p.includes('generated') && !p.includes('node_modules'))
    .filter((p) => /\.ts$/.test(p))
    .filter((p) => statSync(join(root, p)).isFile())
}

// A cross-schema table reference, precise like architecture.test.ts check C:
// either a quoted identifier ("tms".) or a SQL clause keyword immediately
// preceding the qualified name (FROM tms., JOIN tms., INTO tms., etc.). This
// deliberately does NOT match a context word embedded in a dotted topic string
// (fct.tms.assignment.v1), which the own-copy topics.ts legitimately carries.
function crossSchemaQualified(other: string): RegExp[] {
  return [
    new RegExp(`"${other}"\\s*\\.`, 'i'),
    new RegExp(`\\b(from|join|into|update|delete\\s+from)\\s+"?${other}"?\\s*\\.`, 'i'),
  ]
}

describe('analytics rail C4 fact-consumer isolation (spec 11, D98, check 2)', () => {
  const files = walk(join('services', 'analytics', 'src'))

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no analytics src file imports another context service or its source', () => {
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8')
      for (const ctx of OTHER_CONTEXTS) {
        // A package import of another context's service.
        expect(
          new RegExp(`from '@andpay/${ctx}-service'`).test(src),
          `${rel} must not import @andpay/${ctx}-service (C4)`,
        ).toBe(false)
        // A relative import reaching up into another context's source.
        expect(
          new RegExp(`import .* from '\\.\\./\\.\\./${ctx}`).test(src),
          `${rel} must not relative-import services/${ctx} (C4)`,
        ).toBe(false)
        // An import path into another context's source tree (trailing slash, so a
        // bare comment mention of the context name is not a false positive; this
        // mirrors architecture.test.ts check D's `services/<ctx>/`).
        expect(
          src.includes(`services/${ctx}/`),
          `${rel} must not import from services/${ctx}/ (C4)`,
        ).toBe(false)
      }
    }
  })

  it('no analytics src file makes a schema-qualified read of another context', () => {
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8')
      for (const ctx of OTHER_CONTEXTS) {
        for (const pattern of crossSchemaQualified(ctx)) {
          expect(pattern.test(src), `${rel} must not schema-qualify a ${ctx} table (C4)`).toBe(false)
        }
      }
    }
  })
})

// -----------------------------------------------------------------------------
// Task 7 (Fork B, checks 9/10): the analytics_relay harness, proven against the
// EXISTING library functions exactly like check 3 in test/write_plane_c4.test.ts
// (relayOnce / consumeAuthzAudit). NO production daemon is built (ruling C2):
// relayOnce owns its own transaction, so the role is proven by a thin
// $transaction wrapper that runs `SET LOCAL ROLE analytics_relay` BEFORE the
// library's claim query and captures current_user inside that same
// transaction. Auth is UNMODIFIED: this only relays to the EXISTING authz.audit
// topic Auth already consumes via consumeAuthzAudit; the analytics rail is a
// second SOURCE onto that one channel, same as fulfillment/tms in check 3.
// -----------------------------------------------------------------------------

const analyticsUrl =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const authRailUrl =
  process.env.AUTH_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'

const analyticsDb = new AnalyticsClient({ datasourceUrl: analyticsUrl })
const authRailDb = new AuthClient({ datasourceUrl: authRailUrl })

interface RailCaptured {
  user?: string
}

// Byte-identical technique to test/write_plane_c4.test.ts's roleClient: wraps a
// client so the library's OWN internal transaction runs under
// SET LOCAL ROLE <role>, with current_user captured inside that same tx.
function railRoleClient<C extends { $transaction: unknown }>(
  db: C,
  role: string,
  captured: RailCaptured,
): C {
  const base = db as unknown as {
    $transaction: <T>(fn: (tx: RailTxLike) => Promise<T>) => Promise<T>
  }
  return {
    $transaction: <T>(fn: (tx: RailTxLike) => Promise<T>): Promise<T> =>
      base.$transaction(async (tx: RailTxLike) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
        const who = await tx.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`)
        captured.user = who[0]!.u
        return fn(tx)
      }),
  } as unknown as C
}

interface RailTxLike {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

beforeEach(async () => {
  await analyticsDb.$executeRawUnsafe('TRUNCATE analytics.outbox CASCADE')
  await authRailDb.$executeRaw`DELETE FROM authz_audit`
  await authRailDb.$executeRawUnsafe(`DELETE FROM inbox WHERE consumer = '${AUTHZ_AUDIT_CONSUMER}'`)
})

afterAll(async () => {
  await analyticsDb.$disconnect()
  await authRailDb.$disconnect()
})

describe('Task 7: analytics_relay Fork-B harness (checks 9/10, no production daemon)', () => {
  it('relayOnce under analytics_relay drains analytics.outbox and publishes the 6e; current_user = analytics_relay', async () => {
    await emitAnalyticsReadAudit(analyticsDb, {
      principalId: 'prn_relay_1',
      cls: 3,
      operation: 'analytics:tile-read',
      decision: 'ALLOW',
      resourceIds: ['tile_x'],
      traceId: 'trace-relay-1',
    })

    const captured: RailCaptured = {}
    const publisher = new InMemoryPublisher()
    const published = await relayOnce(
      railRoleClient(analyticsDb, 'analytics_relay', captured) as unknown as OutboxClient,
      publisher,
    )

    expect(published).toBe(1)
    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]!.eventType).toBe('authz.audit')
    expect(captured.user).toBe('analytics_relay')

    const unpub = await analyticsDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM analytics.outbox WHERE published_at IS NULL
    `
    expect(Number(unpub[0]!.n)).toBe(0)
  })

  it('the relayed 6e payload appends to the authz.audit chain via consumeAuthzAudit (Auth unmodified, sole appender); a redelivery of the same payload.id is a no-op (E6/D121)', async () => {
    await emitAnalyticsReadAudit(analyticsDb, {
      principalId: 'prn_relay_2',
      cls: 3,
      operation: 'analytics:report-read',
      decision: 'DENY',
      resourceIds: [],
      traceId: 'trace-relay-2',
      reasonCode: 'cls_not_authorized',
    })

    const publisher = new InMemoryPublisher()
    await relayOnce(
      railRoleClient(analyticsDb, 'analytics_relay', {}) as unknown as OutboxClient,
      publisher,
    )
    const payload = publisher.published.find((m) => m.eventType === 'authz.audit')!.payload as {
      id: string
    } & AuthzAuditRecord

    const captured: RailCaptured = {}
    const r1 = await consumeAuthzAudit(
      railRoleClient(authRailDb, 'auth_appender', captured) as unknown as AuthDb,
      payload,
    )
    expect(r1.appended).toBe(true)
    expect(r1.seq).toBe(1)
    expect(captured.user).toBe('auth_appender')

    // Redelivery of the SAME payload.id: a no-op, dedup on payload.id (D121).
    const r2 = await consumeAuthzAudit(
      railRoleClient(authRailDb, 'auth_appender', {}) as unknown as AuthDb,
      payload,
    )
    expect(r2.appended).toBe(false)

    const count = await authRailDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM authz_audit`
    expect(Number(count[0]!.n)).toBe(1)
    const verified = await verifyAuthzChain(authRailDb)
    expect(verified.ok).toBe(true)
    expect(verified.length).toBe(1)
  })

  it('analytics_relay is least-privilege: SELECT+UPDATE on analytics.outbox only, a cross-schema query fails (permission denied)', async () => {
    await expect(
      analyticsDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_relay')
        await tx.$executeRawUnsafe(`SELECT * FROM auth.authz_audit LIMIT 1`)
      }),
    ).rejects.toThrow(/permission denied/i)

    // Within its own schema it may SELECT + UPDATE the outbox (relayOnce's own
    // shape) but not INSERT (that is analytics_write's grant, not the relay's).
    await expect(
      analyticsDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE analytics_relay')
        await tx.$executeRawUnsafe(
          `INSERT INTO analytics.outbox (aggregate_type, aggregate_id, event_type, partition_key, payload)
           VALUES ('x', 'x', 'x', 'x', '{}'::jsonb)`,
        )
      }),
    ).rejects.toThrow(/permission denied/i)

    const usage = await analyticsDb.$queryRawUnsafe<{ own_usage: boolean; other_usage: boolean }[]>(
      `SELECT has_schema_privilege('analytics_relay', 'analytics', 'USAGE') AS own_usage,
              has_schema_privilege('analytics_relay', 'auth', 'USAGE') AS other_usage`,
    )
    expect(usage[0]!.own_usage).toBe(true)
    expect(usage[0]!.other_usage).toBe(false)
  })
})
