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
 * WHY HOSTNAME ALONE IS NOT ENOUGH. A shared instance reached through an SSH
 * or SSM port-forward presents to every client on this machine as
 * `localhost:5432`; hostname classification alone would wave that straight
 * through, and risk 3 of the shared-RDS submission recommends moving to
 * exactly that posture as the stronger one. Every url this file derives for
 * the shared instance carries `sslmode=require` (infra/db-url.mjs), and no
 * local docker url ever does, so the real predicate this file answers is not
 * "is the host loopback" but "is this the local docker database": loopback
 * hostname AND no TLS requested. A tunnel presents the first without the
 * second and is correctly rejected.
 *
 * Fails CLOSED: an unparseable url is treated as non-loopback, because a url
 * this cannot understand is a url it cannot vouch for.
 */

// The six context urls, the outbox library's own test schema url, and the
// maintenance database url used only for bootstrap. Every variable through
// which a suite can reach a database.
export const SCOPED_URL_VARS = [
  'IDENTITY_DATABASE_URL',
  'TMS_DATABASE_URL',
  'FULFILLMENT_DATABASE_URL',
  'ORCHESTRATOR_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'ANALYTICS_DATABASE_URL',
  'OUTBOX_TEST_DATABASE_URL',
  'ANDPAY_ADMIN_DATABASE_URL',
] as const

// An IPv6 literal is bracketed inside a url, and WHATWG keeps the brackets on
// `hostname`, so both forms are listed.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Every url infra/db-url.mjs derives for the shared instance carries
// `sslmode=require`. No local docker url ever sets `sslmode` at all, and a
// value of `disable` is an explicit opt-out, so either absent or `disable`
// means "not requesting TLS". Anything else (`require`, `prefer`,
// `verify-ca`, `verify-full`, ...) means TLS was asked for.
function requestsTls(url: URL): boolean {
  const sslmode = url.searchParams.get('sslmode')
  return sslmode !== null && sslmode.toLowerCase() !== 'disable'
}

// Despite the name, this answers "is this the local docker database", not
// merely "is the hostname loopback": see the header comment above for why a
// loopback hostname that also requests TLS (a port-forward or SSH tunnel to
// shared infrastructure) must still fail this check.
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return LOOPBACK_HOSTS.has(parsed.hostname) && !requestsTls(parsed)
}

export function nonLoopbackVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return SCOPED_URL_VARS.filter((name) => {
    const url = env[name]
    return url !== undefined && url !== '' && !isLoopbackUrl(url)
  })
}

export function loopbackViolationMessage(offenders: string[]): string {
  return (
    `REFUSING TO RUN. These do not resolve to the local docker database: ${offenders.join(', ')}.\n` +
    `Either the host is not loopback, or it is a loopback address that requests TLS, ` +
    `which is how a port-forward or SSH tunnel to shared infrastructure presents.\n` +
    `The test gate TRUNCATEs the four domain schemas and DELETEs auth rows. ` +
    `Against shared infrastructure that destroys the team's dataset.\n` +
    `Tests may only ever run against the local docker Postgres. ` +
    `Open a shell that has NOT sourced infra/rds-env.sh, then: pnpm db:up`
  )
}
