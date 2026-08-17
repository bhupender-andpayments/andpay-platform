/**
 * THE GATE MAY ONLY EVER TALK TO LOCALHOST.
 *
 * `vitest.global-teardown.ts` truncates the four domain schemas and runs a
 * scoped delete across `auth` after every run, and 115 suites truncate in
 * `beforeEach` during it. That is correct against a private docker volume and
 * catastrophic against the shared developer RDS: one `pnpm test` in a shell
 * that has sourced `infra/rds-env.sh` destroys the whole team's dataset.
 *
 * WHY AN ALLOWLIST AND NOT A DENYLIST. Refusing one known RDS hostname
 * protects one instance. Requiring loopback protects every instance that will
 * ever exist, including the next one somebody spins up without telling anyone.
 *
 * Fails CLOSED: an unparseable url is treated as non-loopback, because a url
 * this cannot understand is a url it cannot vouch for.
 */

// The six context urls plus the outbox library's own test schema url. Every
// variable through which a suite can reach a database.
export const SCOPED_URL_VARS = [
  'IDENTITY_DATABASE_URL',
  'TMS_DATABASE_URL',
  'FULFILLMENT_DATABASE_URL',
  'ORCHESTRATOR_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'ANALYTICS_DATABASE_URL',
  'OUTBOX_TEST_DATABASE_URL',
] as const

// An IPv6 literal is bracketed inside a url, and WHATWG keeps the brackets on
// `hostname`, so both forms are listed.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLoopbackUrl(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return LOOPBACK_HOSTS.has(hostname)
}

export function nonLoopbackVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return SCOPED_URL_VARS.filter((name) => {
    const url = env[name]
    return url !== undefined && url !== '' && !isLoopbackUrl(url)
  })
}

export function loopbackViolationMessage(offenders: string[]): string {
  return (
    `REFUSING TO RUN. These point at a non-loopback host: ${offenders.join(', ')}.\n` +
    `The test gate TRUNCATEs the four domain schemas and DELETEs auth rows. ` +
    `Against shared infrastructure that destroys the team's dataset.\n` +
    `Tests may only ever run against the local docker Postgres. ` +
    `Open a shell that has NOT sourced infra/rds-env.sh, then: pnpm db:up`
  )
}
