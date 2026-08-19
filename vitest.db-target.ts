/**
 * THE DATABASE THE TEST GATE IS ALLOWED TO DESTROY.
 *
 * WHY THIS FILE EXISTS (19 Aug 2026, after the fourth data loss in one day).
 *
 * The gate is destructive by design: `vitest.global-teardown.ts` truncates the
 * four domain schemas after every run and ~115 suites truncate in `beforeEach`
 * during it. That is correct. What was wrong is WHICH database it did it to.
 *
 * Every database-backed suite resolves its connection as
 * `process.env.<CTX>_DATABASE_URL ?? 'postgresql://...localhost:5432/andpay?schema=<ctx>'`,
 * and `.env` does not define those six variables at all (it defines the
 * ANDPAY_DB_* parts that `infra/db-url.mjs` derives urls from, for the app).
 * So in a normal shell every one of those reads fell through to its hardcoded
 * fallback and the gate ran against `andpay`: the SAME database the local demo
 * stack and every hand-seeded vendor, tenant and batching config live in.
 *
 * The consequence was not subtle and not rare. `pnpm test` wiped the demo
 * dataset every single time, and so did any `--project node` invocation, even a
 * single file that opens no connection (the marker in
 * `test/db-tests-ran.setup.ts` is written per FILE, unconditionally, so
 * "no database-backed test ran" is not something it can actually detect). The
 * working practice that grew around it was "remember to reseed afterwards",
 * which is not a fix: it fails the first time anyone forgets, and it failed
 * repeatedly.
 *
 * So the gate now points at its OWN database. `andpay_test` holds the same six
 * schemas and the same migrations; nothing but tests ever connects to it, and
 * truncating it costs nothing. `andpay` is left alone.
 *
 * HOW THE OVERRIDE REACHES THE SUITES. `vitest.config.ts` passes the map below
 * as the node project's `test.env`, which sets these variables in every test
 * worker BEFORE any suite constructs a Prisma client. Because each suite reads
 * `process.env.X ?? <fallback>`, the override lands in all of them at once and
 * not one of the ~100 hardcoded fallbacks had to be edited. Those fallbacks
 * stay as they are, and stay pointed at `andpay`, deliberately: they are what a
 * developer gets when running a suite through some path that does not load this
 * config, and a wrong-but-loud connection failure is easier to diagnose than a
 * silent one. The env var is the contract; the fallback is a last resort.
 *
 * THE TEARDOWN NEEDS ITS OWN COPY. `globalSetup` runs in vitest's MAIN process,
 * where `test.env` does not apply, so the teardown imports `testDbUrl` directly
 * rather than relying on the worker environment. One definition, two consumers,
 * so the gate cannot end up truncating a different database than the suites
 * wrote to, which would leave real residue behind while reporting success.
 *
 * STILL LOOPBACK-ONLY. `test/db-loopback.ts` is unchanged and still applies:
 * these urls are localhost with no TLS requested, so they pass it, and a shell
 * that has sourced `infra/rds-env.sh` still fails closed before any suite runs.
 * This file narrows WHICH local database the gate may touch; that one keeps it
 * from ever reaching a remote instance.
 */

/** Created and migrated by `bash infra/db-test-bootstrap.sh`. */
export const TEST_DB_NAME = 'andpay_test'

/**
 * The local docker credentials, matching every suite's own fallback and
 * `infra/docker-compose.dev.yml`. Not a secret: it is the throwaway password of
 * a container that only ever listens on loopback (S4 is about real
 * credentials, and this is the same literal already written in ~100 test files
 * and in the teardown's own default).
 */
function url(schema: string): string {
  return `postgresql://andpay:andpay_dev@localhost:5432/${TEST_DB_NAME}?schema=${schema}`
}

export function testDbUrl(schema: string): string {
  return url(schema)
}

/**
 * Every variable through which a suite can reach a database, pinned to the test
 * database. Deliberately the same list as `SCOPED_URL_VARS` in
 * `test/db-loopback.ts` minus `ANDPAY_ADMIN_DATABASE_URL`, which is a
 * maintenance connection used only by bootstrap scripts and is not something a
 * suite should be handed at all.
 *
 * `OUTBOX_TEST_DATABASE_URL` is included because the outbox library owns its
 * own `outbox_test` schema and pushes to it directly (`pnpm --filter
 * @andpay/outbox db:push:test`); leaving it pointed at `andpay` would keep one
 * foot in the demo database.
 */
export const TEST_DB_ENV: Record<string, string> = {
  IDENTITY_DATABASE_URL: url('identity'),
  TMS_DATABASE_URL: url('tms'),
  FULFILLMENT_DATABASE_URL: url('fulfillment'),
  ORCHESTRATOR_DATABASE_URL: url('orchestrator'),
  AUTH_DATABASE_URL: url('auth'),
  ANALYTICS_DATABASE_URL: url('analytics'),
  OUTBOX_TEST_DATABASE_URL: url('outbox_test'),
}
