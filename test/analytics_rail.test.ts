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
 * this is a STATIC net over that source AND test tree asserting the boundary
 * holds (the registered arch-guard-scans-per-context-tests principle: a future
 * test-file cross-context reference must not pass silently). It models the
 * precise patterns of test/architecture.test.ts checks C (schema-qualified)
 * and D (source import): a bare context word inside a topic string like
 * 'fct.tms.assignment.v1' is NOT a cross-schema read, and a comment mentioning a
 * context by name (services/tms, no trailing slash) is NOT an import, so both
 * legitimately survive the guard while a real breach does not. The import
 * detection also flags a dynamic import('@andpay/<ctx>-service'), a
 * double-quoted import, and any bare @andpay/<ctx>-service substring, so a
 * breach cannot dodge the guard by changing quote style or import form.
 *
 * Plant-and-remove recipe (to prove this guard bites): add a line such as
 *   import { AssignmentFactPayload } from '@andpay/tms-service'
 * (or a raw read `FROM tms.raw_event`) to any file under services/analytics/src
 * or services/analytics/test. Run `pnpm exec vitest run test/analytics_rail.test.ts`:
 * this block fails. Remove the planted line: it passes again.
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
  const files = [
    ...walk(join('services', 'analytics', 'src')),
    ...walk(join('services', 'analytics', 'test')),
  ]

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('no analytics src or test file imports another context service or its source', () => {
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8')
      for (const ctx of OTHER_CONTEXTS) {
        // A static package import of another context's service, either quote
        // style (from '@andpay/<ctx>-service' or from "@andpay/<ctx>-service").
        expect(
          new RegExp(`from\\s+['"]@andpay/${ctx}-service['"]`).test(src),
          `${rel} must not import @andpay/${ctx}-service (C4)`,
        ).toBe(false)
        // A dynamic import of another context's service, either quote style.
        expect(
          new RegExp(`import\\(\\s*['"]@andpay/${ctx}-service['"]\\s*\\)`).test(src),
          `${rel} must not dynamically import @andpay/${ctx}-service (C4)`,
        ).toBe(false)
        // A catch-all: any bare @andpay/<ctx>-service substring, regardless of
        // quote style or import form, so a breach cannot dodge the two checks
        // above by reformatting the import.
        expect(
          src.includes(`@andpay/${ctx}-service`),
          `${rel} must not reference @andpay/${ctx}-service (C4)`,
        ).toBe(false)
        // A relative import reaching up into another context's source.
        expect(
          new RegExp(`import .* from ['"]\\.\\./\\.\\./${ctx}`).test(src),
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

  it('no analytics src or test file makes a schema-qualified read of another context', () => {
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

// -----------------------------------------------------------------------------
// Task 9 (check 10): read-only-consumed catalog negatives. The rail emits NO
// fct.*/cmd.* event, holds NO money/ledger/saga table, writes only its own
// analytics schema, and no other context grants the analytics roles write on
// a foreign schema. NOT load-bearing security; catalog/grep assertions that
// mirror the existing C4 guard above and the cross-schema-denied technique in
// the Task 7 block and test/write_plane_c4.test.ts.
// -----------------------------------------------------------------------------

describe('read-only-consumed (check 10)', () => {
  const analyticsFiles = walk(join('services', 'analytics', 'src'))
  const auditPath = join('services', 'analytics', 'src', 'audit.ts')

  it('has files to check', () => {
    expect(analyticsFiles.length).toBeGreaterThan(0)
  })

  it('the only enqueue() call sites in services/analytics/src are the authz.audit 6e in audit.ts; none enqueues a fct.*/cmd.* event', () => {
    const enqueueSites: { rel: string; line: string }[] = []
    for (const rel of analyticsFiles) {
      const src = readFileSync(join(root, rel), 'utf8')
      src.split('\n').forEach((line) => {
        const trimmed = line.trim()
        // A real call site, not a comment mentioning "enqueue" (e.g. audit.ts's
        // own landmine note above the call), mirroring the C4 guard's care to
        // distinguish a comment mention from an actual breach.
        if (/\benqueue\s*\(/.test(line) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
          enqueueSites.push({ rel, line })
        }
      })
    }
    // Non-vacuous: there ARE enqueue call sites (the 6e emit), just none is a
    // fact/command producer. A vacuous "zero sites" pass would not prove this.
    expect(enqueueSites.length).toBeGreaterThan(0)
    for (const { rel, line } of enqueueSites) {
      expect(rel, `enqueue() call outside audit.ts: ${rel}: ${line}`).toBe(auditPath)
      expect(
        /buildAuthzAuditEvent/.test(line),
        `enqueue() call in ${rel} does not build the authz.audit event: ${line}`,
      ).toBe(true)
      expect(
        /['"`]fct\./.test(line),
        `enqueue() call in ${rel} appears to emit a fct.* event: ${line}`,
      ).toBe(false)
      expect(
        /['"`]cmd\./.test(line),
        `enqueue() call in ${rel} appears to emit a cmd.* event: ${line}`,
      ).toBe(false)
    }
  })

  it('no fct.*/cmd.* producer helper (FactEnvelope/buildFactEvent/emitFact*) exists anywhere in analytics src', () => {
    for (const rel of analyticsFiles) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(/FactEnvelope/.test(src), `${rel} must not define/import a FactEnvelope helper`).toBe(false)
      expect(
        /\bbuild(Fact|Cmd)\w*Event\b/.test(src),
        `${rel} must not define a fact/cmd producer helper`,
      ).toBe(false)
      expect(/\bemitFact\w*\(/.test(src), `${rel} must not define/call an emitFact* producer`).toBe(false)
    }
  })

  it('the analytics schema holds exactly the 5 rail tables (raw_event, dispatch_row, inbox, outbox, analytics_watermark); no ledger/posting/saga table', async () => {
    const rows = await analyticsDb.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'analytics' AND table_type = 'BASE TABLE' AND table_name != '_prisma_migrations'
       ORDER BY table_name`,
    )
    const names = rows.map((r) => r.table_name).sort()
    expect(names).toEqual(['analytics_watermark', 'dispatch_row', 'inbox', 'outbox', 'raw_event'])
  })

  it('analytics_read/analytics_write/analytics_relay have USAGE on schema analytics only, never on any other context schema', async () => {
    // Full matrix over every other context schema (identity, auth, tms,
    // fulfillment, orchestrator), not just tms/fulfillment: a stray
    // GRANT USAGE ON SCHEMA identity/auth/orchestrator TO analytics_* (without
    // an accompanying table grant) would otherwise slip past this check.
    for (const role of ['analytics_read', 'analytics_write', 'analytics_relay']) {
      const ownUsage = await analyticsDb.$queryRawUnsafe<{ own_usage: boolean }[]>(
        `SELECT has_schema_privilege('${role}', 'analytics', 'USAGE') AS own_usage`,
      )
      // Non-vacuous proof-of-life: this assertion is TRUE, so the check below
      // (which asserts FALSE for every other schema) is capable of catching a
      // real grant rather than passing on a tautology.
      expect(ownUsage[0]!.own_usage, `${role} must have USAGE on analytics`).toBe(true)

      for (const other of OTHER_CONTEXTS) {
        const rows = await analyticsDb.$queryRawUnsafe<{ other_usage: boolean }[]>(
          `SELECT has_schema_privilege('${role}', '${other}', 'USAGE') AS other_usage`,
        )
        expect(rows[0]!.other_usage, `${role} must NOT have USAGE on ${other}`).toBe(false)
      }
    }
  })

  it('a cross-schema SELECT into tms is denied under both analytics_read and analytics_write (permission denied for schema tms)', async () => {
    for (const role of ['analytics_read', 'analytics_write']) {
      await expect(
        analyticsDb.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
          await tx.$executeRawUnsafe(`SELECT * FROM tms.assignment LIMIT 1`)
        }),
        `${role} must be denied a cross-schema read of tms.assignment`,
      ).rejects.toThrow(/permission denied for schema tms/i)
    }
  })

  it('no analytics role (analytics_read/analytics_write/analytics_relay) is granted on any table outside the analytics schema', async () => {
    const rows = await analyticsDb.$queryRawUnsafe<{ table_schema: string; grantee: string; table_name: string }[]>(
      `SELECT DISTINCT table_schema, grantee, table_name FROM information_schema.role_table_grants
       WHERE grantee IN ('analytics_read', 'analytics_write', 'analytics_relay')`,
    )
    // Non-vacuous: the roles DO have grants (on their own schema); the check is
    // that every one of those grants is schema = analytics.
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(
        row.table_schema,
        `${row.grantee} must not be granted on ${row.table_schema}.${row.table_name}`,
      ).toBe('analytics')
    }
  })
})
