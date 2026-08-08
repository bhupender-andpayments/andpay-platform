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

export async function teardown(): Promise<void> {
  // Escape hatch for the case where you WANT the rows: debugging a failing test
  // by inspecting what it left behind.
  if (process.env[SKIP_ENV] === '1') {
    console.log(`${TAG} skipped (${SKIP_ENV}=1); the database keeps whatever the run left.`)
    return
  }

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
  console.log(`${TAG} ${results.join(' | ')}. auth and orchestrator untouched.`)
}
