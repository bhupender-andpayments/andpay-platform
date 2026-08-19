import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_DB_NAME, TEST_DB_ENV, testDbUrl } from '../vitest.db-target.js'
import { SCOPED_URL_VARS, isLoopbackUrl } from './db-loopback.js'

// THE GUARD ON THE 19 Aug 2026 FIX, and it is worth more than most tests here.
//
// The gate is destructive: the global teardown truncates the four domain
// schemas after every run and ~115 suites truncate in beforeEach during it. It
// used to do that to `andpay`, the SAME database the local demo stack and every
// hand-seeded vendor, tenant and batching config live in, because every suite
// resolves its connection as `process.env.X ?? <hardcoded andpay fallback>` and
// nothing set those variables. The demo dataset was destroyed on every single
// `pnpm test`, and on any `--project node` run, four times in one day before
// the cause was found rather than worked around.
//
// The fix has three moving parts that must agree: the env map this project
// injects, the teardown's own target (it runs in vitest's main process, where
// that env does not apply), and the database that actually exists. If any one
// drifts, the failure is silent and expensive: the gate goes back to truncating
// live data, and nothing fails to say so. Hence assertions rather than trust.
const root = join(import.meta.dirname, '..')

describe('the test gate is isolated from the demo database', () => {
  // THE ONE THAT MATTERS. If this fails, running the suite is destroying
  // somebody's data right now.
  it('runs against the test database, never the demo database', () => {
    for (const name of ['IDENTITY_DATABASE_URL', 'TMS_DATABASE_URL', 'FULFILLMENT_DATABASE_URL', 'AUTH_DATABASE_URL', 'ANALYTICS_DATABASE_URL', 'ORCHESTRATOR_DATABASE_URL'] as const) {
      const url = process.env[name]
      expect(url, `${name} must be set for the gate; vitest.config.ts injects it`).toBeDefined()
      expect(new URL(url!).pathname, `${name} must name /${TEST_DB_NAME}`).toBe(`/${TEST_DB_NAME}`)
    }
  })

  // A suite that opens a connection some OTHER way still must not reach the
  // demo database. This catches a new url variable being added to the loopback
  // guard's list without being pinned in the env map.
  it('pins every url variable a suite can reach a database through', () => {
    const unpinned = SCOPED_URL_VARS.filter(
      // ANDPAY_ADMIN_DATABASE_URL is a maintenance connection for bootstrap
      // scripts and is deliberately not handed to suites at all.
      (name) => name !== 'ANDPAY_ADMIN_DATABASE_URL' && TEST_DB_ENV[name] === undefined,
    )
    expect(unpinned, 'add these to TEST_DB_ENV in vitest.db-target.ts').toEqual([])
  })

  // The narrowing must not have weakened the older, broader protection: the
  // gate may still only ever talk to the local docker database.
  it('keeps every pinned url loopback and TLS-free, so the RDS guard still holds', () => {
    for (const [name, url] of Object.entries(TEST_DB_ENV)) {
      expect(isLoopbackUrl(url), `${name} must satisfy test/db-loopback.ts`).toBe(true)
    }
  })

  // The teardown cannot import the worker environment, so it carries its own
  // copy of the target. Two definitions of "which database may be truncated" is
  // exactly the drift that would truncate one while the suites wrote another,
  // leaving real residue behind under a green run.
  it('has a teardown pointed at the same database, and one that ignores process.env', () => {
    const text = readFileSync(join(root, 'vitest.global-teardown.ts'), 'utf8')
    expect(text, 'the teardown must import the shared target').toContain("from './vitest.db-target.js'")

    // CODE ONLY. That file documents at length what was removed and why, so it
    // legitimately CONTAINS both forbidden strings in prose; matching raw text
    // would fail on the explanation rather than on a real regression. Comment
    // lines are dropped before asserting.
    const code = text
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')

    // The demo database's name must not be constructible in the teardown at all.
    expect(code, 'the teardown must not build an andpay url').not.toContain('localhost:5432/andpay?')
    // And it must not take a per-shell override: the app's own urls point at
    // the demo database, and any shell that exported them (the local restart
    // script does) would otherwise hand them straight to the truncation.
    expect(code, 'connect() must not read a url out of the environment').not.toContain('process.env[urlVar]')
  })

  it('derives its urls from one place, so the name cannot drift', () => {
    expect(testDbUrl('fulfillment')).toBe(TEST_DB_ENV['FULFILLMENT_DATABASE_URL'])
    expect(TEST_DB_NAME).not.toBe('andpay')
  })
})
