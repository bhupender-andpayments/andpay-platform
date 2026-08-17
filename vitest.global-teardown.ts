/**
 * ONE teardown for the whole gate, instead of 82 per-suite ones (F-9c).
 *
 * THE PROBLEM. A suite that truncates in `beforeEach` only always leaves
 * whatever its FINAL test inserted sitting in the database, for the rest of the
 * run and beyond. A scan found 82 suites with exactly that shape. The rows are
 * invisible to the gate, because a leak is a SIDE EFFECT and not a failure: the
 * tests pass either way. They surface later, in the demo, as objects nobody
 * created. That is how an `Acme` merchant reached a real screen (F-9), and how a
 * courier credential and an `AWB1` shipment outlived their suite by days (F-9b).
 *
 * WHY HERE AND NOT IN 82 FILES. Per-suite teardown is the wrong unit of work.
 * It was measured: after fixing the five courier suites, ONE run of the
 * fulfillment package put the same class of residue straight back from a
 * different suite. Fixing them one at a time also does nothing about the NEXT
 * suite somebody writes, and the mistake is trivially easy to repeat. One
 * teardown covers every suite that exists and every suite that will exist, and
 * makes the post-gate state DETERMINISTIC (empty) rather than "whatever the last
 * test in each file happened to insert".
 *
 * This does not replace per-suite `beforeEach` truncation and must not be read
 * as permission to drop it. Suites still need isolation FROM EACH OTHER during
 * the run; this only guarantees the database is clean AFTER it.
 *
 * ON C4. This file names all four domain contexts, which product code may never
 * do. It is not product code and integrates nothing: it is the harness that owns
 * the physical database. It still connects per context with that context's OWN
 * url and truncates only that context's own tables, so the documented later
 * split to an instance-per-context stays a connection-string change (CLAUDE.md).
 */

import { existsSync, rmSync } from 'node:fs'
import { DB_TESTS_RAN_MARKER } from './vitest.db-marker.js'

// The four DOMAIN contexts. Deliberately a literal list, not "every schema".
const DOMAIN_CONTEXTS = [
  { ctx: 'identity', schema: 'identity', urlVar: 'IDENTITY_DATABASE_URL' },
  { ctx: 'tms', schema: 'tms', urlVar: 'TMS_DATABASE_URL' },
  { ctx: 'fulfillment', schema: 'fulfillment', urlVar: 'FULFILLMENT_DATABASE_URL' },
  { ctx: 'analytics', schema: 'analytics', urlVar: 'ANALYTICS_DATABASE_URL' },
] as const

/**
 * GUARD 1: SCHEMAS THIS MUST NEVER TOUCH.
 *
 * `auth` holds the demo login (one operator principal plus its MFA enrollment)
 * and the HASH-CHAINED authz audit ledger. Truncating it locks everyone out of
 * the demo and breaks a chain whose whole value is that it cannot be rewritten.
 * `orchestrator` is not a demo domain and nothing here seeds it.
 *
 * This is asserted below rather than merely documented, so that adding a context
 * to DOMAIN_CONTEXTS by copy-paste cannot quietly include one of these.
 */
const NEVER_TRUNCATE = new Set(['auth', 'orchestrator'])

/**
 * GUARD 2: UNSEEDED MASTER DATA, PRESERVED.
 *
 * These tables are NOT created by any migration and NOT restored by any harness
 * seeder. They were populated by hand or through the portal, so truncating them
 * destroys state that nothing in this repository can rebuild. Both were found
 * the hard way while resetting the demo database on 2026-08-08.
 *
 * `tms.damage_reason` backs the damage-upload flow. `bank_composition_config`
 * backs QR/collateral composition.
 *
 * If a table here stops existing, that is reported rather than ignored: a stale
 * preserve entry means the real table is now being truncated under a new name.
 */
const PRESERVE: Record<string, readonly string[]> = {
  tms: ['damage_reason'],
  fulfillment: ['bank_composition_config'],
}

// Prisma's own bookkeeping. Truncating it would make the next `db.sh` replay
// every migration against a database that already has them.
const ALWAYS_SKIP = ['_prisma_migrations']

const SKIP_ENV = 'ANDPAY_SKIP_TEST_TEARDOWN'
const TAG = '[global-teardown]'

/**
 * THE SCOPED AUTH PASS (F-4), and why it is DELETE and never TRUNCATE.
 *
 * `auth` stays in NEVER_TRUNCATE above: that guard is not weakened, because
 * emptying these tables really would destroy the demo login and the audit
 * chain. But refusing to truncate is not the same as refusing to tidy, and the
 * gap between the two was a leak that ran for months: 2047 principals, 2238
 * enrollments, 2412 refresh tokens and 355 vendor operators had accumulated by
 * 2026-08-09, growing every gate.
 *
 * The choke-point cleanup in the two auth edge helpers closed most of it, and
 * principals reached their floor. It could not close the tail, because several
 * suites mint these rows DIRECTLY rather than through a helper, and no fix that
 * lives in a helper can cover a suite that does not call it. Fixing those one at
 * a time is the same wrong unit of work this whole file exists to reject, and it
 * does nothing about the next suite somebody writes.
 *
 * So the rule here is the exact inverse of the domain contexts': instead of
 * "empty everything except a preserve list", it is "delete everything EXCEPT the
 * demo login, and never look at the ledger at all".
 *
 * WHAT IS PROTECTED, AND HOW:
 *   - `authz_audit` is HASH-CHAINED. It is not in the delete list, and its row
 *     count is compared before and after so a future FK or a careless edit
 *     cannot empty it silently. Rows there must never be removed to tidy up.
 *   - `outbox` is deliberately untouched. It carries undrained credential facts
 *     that A-7 (the missing auth relay) still has to reason about; deleting them
 *     would destroy the evidence for an open decision.
 *   - The demo operator principal and its MFA enrollment survive by handle.
 *
 * If the demo login is absent the pass still runs, because then every row IS
 * residue, but it says so: a missing demo login means the guard protected
 * nothing on this run, and `serve.mjs` re-provisions the operator on boot.
 */
const AUTH_SCHEMA = 'auth'
const AUTH_URL_VAR = 'AUTH_DATABASE_URL'
const DEMO_LOGIN_HANDLE = 'ops.admin'
const AUTH_LEDGER = 'authz_audit'
const AUTH_UNTOUCHED = [AUTH_LEDGER, 'outbox', '_prisma_migrations']

function defaultUrl(schema: string): string {
  return `postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=${schema}`
}

interface RawClient {
  $queryRawUnsafe<T>(sql: string): Promise<T>
  $executeRawUnsafe(sql: string): Promise<number>
  $disconnect(): Promise<void>
}

async function connect(ctx: string, urlVar: string, schema: string): Promise<RawClient | null> {
  // Dynamic, and per context, so a context whose client has not been generated
  // yet degrades to a warning instead of taking the whole run down with an
  // import error. Cleanup failing must never fail a green gate. Generated
  // clients are gitignored, so "not generated yet" is a normal state on a fresh
  // checkout, not an exceptional one.
  let mod: { PrismaClient: new (opts: { datasources: { db: { url: string } } }) => RawClient }
  try {
    mod = (await import(`./services/${ctx}/generated/client/index.js`)) as typeof mod
  } catch {
    console.error(`${TAG} no generated client for ${ctx}; its tables were NOT cleaned. Run: bash ./infra/db.sh`)
    return null
  }
  const url = process.env[urlVar] ?? defaultUrl(schema)
  return new mod.PrismaClient({ datasources: { db: { url } } })
}

async function countRows(db: RawClient, schema: string, table: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${schema}"."${table}"`)
  return Number(rows[0]?.n ?? 0)
}

async function truncateContext(ctx: string, schema: string, urlVar: string): Promise<string> {
  // Guard 1, enforced rather than trusted.
  if (NEVER_TRUNCATE.has(schema)) {
    throw new Error(`${TAG} refusing to truncate protected schema "${schema}"`)
  }

  const db = await connect(ctx, urlVar, schema)
  if (db === null) return `${ctx}: skipped (no client)`

  try {
    const preserve = PRESERVE[schema] ?? []

    // Enumerate at RUNTIME rather than hard-coding a table list. A hard-coded
    // list silently stops covering tables added after it was written, which is
    // the same class of bug as the leak this file exists to fix.
    const all = await db.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    )
    const names = all.map((r) => r.table_name)

    // A preserve entry naming a table that no longer exists means the list is
    // stale, and a stale list means something IS being truncated that this file
    // believes it is protecting. Say so.
    for (const p of preserve) {
      if (!names.includes(p)) {
        console.error(`${TAG} WARNING: preserve entry "${schema}.${p}" does not exist. The preserve list is stale.`)
      }
    }

    const targets = names.filter((n) => !preserve.includes(n) && !ALWAYS_SKIP.includes(n))
    if (targets.length === 0) return `${ctx}: nothing to truncate`

    // Guard 2, measured rather than assumed. Nothing references the preserved
    // tables today, so CASCADE cannot reach them, but an FK added later WOULD
    // make CASCADE empty them silently. Compare before and after.
    const before = new Map<string, number>()
    for (const p of preserve) {
      if (names.includes(p)) before.set(p, await countRows(db, schema, p))
    }

    const list = targets.map((t) => `"${schema}"."${t}"`).join(', ')
    // One statement plus CASCADE so FK order does not have to be hand-sorted.
    await db.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`)

    for (const [p, n] of before) {
      const after = await countRows(db, schema, p)
      if (after !== n) {
        console.error(
          `${TAG} ALERT: preserved table "${schema}.${p}" went from ${String(n)} to ${String(after)} rows. ` +
            `A foreign key now reaches it through TRUNCATE ... CASCADE, so it is no longer protected.`,
        )
      }
    }

    return `${ctx}: ${String(targets.length)} truncated` + (preserve.length > 0 ? `, ${String(preserve.length)} preserved` : '')
  } finally {
    await db.$disconnect()
  }
}

async function cleanAuthScoped(): Promise<string> {
  const db = await connect(AUTH_SCHEMA, AUTH_URL_VAR, AUTH_SCHEMA)
  if (db === null) return 'auth: skipped (no client)'

  try {
    // The ledger's height before anything is deleted. Guard 3.
    const ledgerBefore = await countRows(db, AUTH_SCHEMA, AUTH_LEDGER)

    const keep = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "${AUTH_SCHEMA}"."internal_principal" WHERE login_handle = '${DEMO_LOGIN_HANDLE}'`,
    )
    const demoPresent = Number(keep[0]?.n ?? 0) > 0
    if (!demoPresent) {
      console.error(
        `${TAG} WARNING: demo login "${DEMO_LOGIN_HANDLE}" not found in auth.internal_principal, so nothing was ` +
          `preserved on this run. Restart serve.mjs to re-provision it.`,
      )
    }

    // Children first: the auth schema declares NO foreign keys, so nothing
    // cascades and an orphan would simply be left behind. Every DELETE is
    // anchored to "does not belong to the demo login", never to a name shape.
    const notDemo =
      `principal_id NOT IN (SELECT id FROM "${AUTH_SCHEMA}"."internal_principal" ` +
      `WHERE login_handle = '${DEMO_LOGIN_HANDLE}')`
    const refresh = await db.$executeRawUnsafe(`DELETE FROM "${AUTH_SCHEMA}"."refresh_token" WHERE ${notDemo}`)
    const mfa = await db.$executeRawUnsafe(`DELETE FROM "${AUTH_SCHEMA}"."mfa_enrollment" WHERE ${notDemo}`)
    const principals = await db.$executeRawUnsafe(
      `DELETE FROM "${AUTH_SCHEMA}"."internal_principal" WHERE login_handle <> '${DEMO_LOGIN_HANDLE}'`,
    )
    // No vendor_operator is ever seeded by the demo harness (checked against
    // the live database and against serve.mjs, which provisions none), so every
    // row is test residue.
    const operators = await db.$executeRawUnsafe(`DELETE FROM "${AUTH_SCHEMA}"."vendor_operator"`)

    const ledgerAfter = await countRows(db, AUTH_SCHEMA, AUTH_LEDGER)
    if (ledgerAfter !== ledgerBefore) {
      console.error(
        `${TAG} ALERT: hash-chained "${AUTH_SCHEMA}.${AUTH_LEDGER}" went from ${String(ledgerBefore)} to ` +
          `${String(ledgerAfter)} rows. The audit chain must never be trimmed by cleanup.`,
      )
    }

    const n = principals + operators + mfa + refresh
    return (
      `auth: ${String(n)} residue rows deleted ` +
      `(${String(principals)} principal, ${String(operators)} operator, ${String(mfa)} mfa, ${String(refresh)} refresh), ` +
      `${AUTH_UNTOUCHED.join('/')} untouched`
    )
  } finally {
    await db.$disconnect()
  }
}

/**
 * THE KAFKA PASS (F-10), and why it is an OFFSET RESET and never a topic
 * delete.
 *
 * The gate does not only leave rows behind, it leaves MESSAGES behind. The
 * bus acceptance test (packages/bus/test/roundtrip.test.ts) publishes a
 * synthetic envelope onto the real fct.identity.merchant.v1 topic on the real
 * local Redpanda, because the thing it proves (outbox row -> real publisher
 * -> real consumer -> inbox dedup) is only proven against the real rail. That
 * message is correct there and poison everywhere else: its payload is not a
 * merchant fact, so when the DEMO's tms consumer group reads it on the next
 * boot, the projector hands an undefined wire id to the ids parser and the
 * message walks the retry ladder into the DLQ. Observed on 2026-08-16 in two
 * consecutive boots at different commits, one dead-lettered mrch_rt_<epoch>
 * per gate run, accumulating forever.
 *
 * The truncation above already destroys every database effect this run's
 * messages had, so replaying ANY of them into the emptied projections is
 * wrong by construction, not just noisy. The coherent reset is therefore:
 * the store and the stream move together. Each local demo consumer group's
 * committed offsets are advanced to the topic ends, so the next boot resumes
 * from now instead of replaying the gate. Messages are never deleted, topics
 * are never dropped or created (S23: provisioning is out of band), and the
 * retry ladder is untouched: a message already mid-ladder from an earlier
 * boot is skipped for the same reason, its database context no longer
 * exists.
 *
 * Loud, never fatal, like everything else here: no broker, no kafkajs, or a
 * group with LIVE members (the demo running during a partial run) degrades
 * to a warning. A live group needs no reset anyway, because its consumers
 * saw this run's messages as they were published.
 *
 * VERIFIED 2026-08-16: full gate (which publishes one fresh mrch_rt_ fact),
 * this pass reports the reset, `bash scripts/demo.sh` boots with zero
 * retry/DLQ lines in the consumer log. Before the pass existed, the same
 * sequence dead-lettered the fact within a minute of boot.
 */
const DEMO_CONSUMER_CONTEXTS = ['identity', 'tms', 'fulfillment', 'analytics', 'auth'] as const

async function resetDemoConsumerGroups(): Promise<string> {
  let kafkajs: typeof import('kafkajs')
  try {
    kafkajs = await import('kafkajs')
  } catch {
    console.error(`${TAG} kafkajs not installed; demo consumer groups were NOT reset. Run: pnpm install`)
    return 'kafka: skipped (no kafkajs)'
  }

  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',').map((b) => b.trim())
  const kafka = new kafkajs.Kafka({ clientId: 'andpay-global-teardown', brokers, logLevel: kafkajs.logLevel.NOTHING })
  const admin = kafka.admin()
  try {
    await admin.connect()
  } catch {
    console.error(`${TAG} Kafka broker unreachable at ${brokers.join(',')}; demo consumer groups were NOT reset.`)
    return 'kafka: skipped (broker unreachable)'
  }

  let groupsReset = 0
  let topicsReset = 0
  const liveGroups: string[] = []
  try {
    for (const ctx of DEMO_CONSUMER_CONTEXTS) {
      // The group id shape is pinned by apps/consumer (groupIdFor). A literal
      // here for the same reason the schema list above is a literal: adding a
      // sixth context must be a deliberate edit, not an accident.
      const groupId = `andpay.${ctx}.v1`
      try {
        const committed = await admin.fetchOffsets({ groupId })
        const topics = committed
          .filter((t) => t.partitions.some((p) => p.offset !== '-1'))
          .map((t) => t.topic)
        if (topics.length === 0) continue
        for (const topic of topics) {
          await admin.resetOffsets({ groupId, topic, earliest: false })
          topicsReset += 1
        }
        groupsReset += 1
      } catch (err) {
        // kafkajs refuses to move a group that has live members. That is the
        // demo running during this test run, and a live consumer already read
        // this run's messages the moment they were published; there is
        // nothing coherent left to skip.
        const msg = err instanceof Error ? err.message : String(err)
        liveGroups.push(groupId)
        console.error(`${TAG} group ${groupId} not reset (${msg}); if the demo is running, its consumers already saw this run's messages.`)
      }
    }
  } finally {
    await admin.disconnect()
  }

  const live = liveGroups.length > 0 ? `, ${String(liveGroups.length)} live (untouched)` : ''
  return `kafka: ${String(groupsReset)} consumer groups advanced to latest across ${String(topicsReset)} topics${live}`
}

export async function teardown(): Promise<void> {
  // Escape hatch for the case where you WANT the rows: debugging a failing test
  // by inspecting what it left behind.
  if (process.env[SKIP_ENV] === '1') {
    console.log(`${TAG} skipped (${SKIP_ENV}=1); the database keeps whatever the run left.`)
    return
  }

  // GUARD 3: NEVER CLEAN UP AFTER TESTS THAT TOUCHED NO DATABASE (2026-08-13,
  // added after a real data loss).
  //
  // This teardown is a ROOT-level globalSetup, so it fires after ANY vitest run
  // from the repo root - including `--project ops-portal`, a jsdom-only project
  // that opens no connection. It truncated a live dev database's units,
  // vendors, merchants and assignments on the back of a pure React test run,
  // because it had no way to know that nothing had been written.
  //
  // The `node` project (the only one whose suites use Postgres) writes this
  // marker from its setupFiles, once per test file. No marker means no
  // database-backed test ran, which means there is no residue to clean and
  // nothing here should touch a row. Removed after a real pass so the next run
  // re-earns it rather than inheriting this one's verdict.
  if (!existsSync(DB_TESTS_RAN_MARKER)) {
    console.log(`${TAG} skipped: no database-backed test ran, so there is no residue to clean.`)
    return
  }
  rmSync(DB_TESTS_RAN_MARKER, { force: true })

  const results: string[] = []
  for (const { ctx, schema, urlVar } of DOMAIN_CONTEXTS) {
    try {
      results.push(await truncateContext(ctx, schema, urlVar))
    } catch (err) {
      // Loud, never fatal. Failing cleanup must not turn a green gate red, but
      // it must also never pass unnoticed, or the residue is back and silent.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${TAG} FAILED for ${ctx}: ${msg}`)
      results.push(`${ctx}: FAILED`)
    }
  }
  // auth is never TRUNCATEd (guard 1 still refuses it); it gets the scoped
  // DELETE pass above instead, which preserves the demo login and the ledger.
  try {
    results.push(await cleanAuthScoped())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`${TAG} FAILED for auth: ${msg}`)
    results.push('auth: FAILED')
  }
  // The stream resets with the store (F-10 above): after the truncations,
  // advance the demo consumer groups past everything this run published.
  try {
    results.push(await resetDemoConsumerGroups())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`${TAG} FAILED for kafka: ${msg}`)
    results.push('kafka: FAILED')
  }

  console.log(`${TAG} ${results.join(' | ')}. orchestrator untouched.`)
}
