# Shared developer RDS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the team share one AWS RDS Postgres dataset for portal and demo
work, while the test gate stays local and cannot destroy that dataset.

**Architecture:** One node module parses `.env` literally and derives the six
`<CTX>_DATABASE_URL` values with a percent-encoded password. A sourced shell
wrapper exports them, so every existing consumer (the three edges, the demo
harness, `infra/db.sh`) picks them up through the `process.env` reads it already
performs, with no application code change. Three guards make the arrangement
safe: the gate refuses to run against a non-loopback host, the teardown refuses
to truncate one, and the build fails if an RDS endpoint is ever committed.

**Tech Stack:** Node 22 ESM, TypeScript strict (NodeNext), vitest, bash, psql,
Prisma 6.3.0, PostgreSQL 16.

**Spec:** `docs/plan/CORPUS_SUBMISSION_2026-08-17_SHARED_DEV_RDS.md`

## Global Constraints

- Nothing in this plan may be implemented before Bhupender ratifies the
  submission. Task 0 is a hard gate.
- No em-dashes or en-dashes in any document, comment, or commit message. Use
  periods or commas (CLAUDE.md DO-NOT list).
- Secrets never in code, config files, logs, events, or IDs (S4). The only
  place the password may exist is the gitignored `.env`.
- No cross-schema query, join, or FK, and no context may reference another
  context's schema (C4, T1, T7).
- The six contexts, in the order the repository uses them: `identity`, `tms`,
  `fulfillment`, `orchestrator`, `auth`, `analytics`.
- `pnpm -r build` is REQUIRED before `pnpm test`, because `@andpay/*` resolve
  through `dist`.
- `noUncheckedIndexedAccess` is on. Indexing a `Record<string, T>` yields
  `T | undefined` and must be handled.
- Deviation from the submission, deliberate: Section 8 step 5 of the spec
  proposed changing the three edge `deps.ts` sites to consult the resolver.
  That is unnecessary. `buildOpsEdgeDepsFromEnv` and its two siblings already
  read `process.env.<CTX>_DATABASE_URL` with a localhost fallback
  (`apps/ops-edge/src/deps.ts:108-111`), so exporting the variables is
  sufficient. No application code is modified by this plan.

---

## File Structure

**Created:**

- `infra/db-url.mjs` sole implementation of `.env` parsing, password encoding,
  and URL derivation. Importable by node consumers, and a CLI that prints
  shell `export` lines.
- `infra/db-url.d.mts` hand-written types so `test/` can import the `.mjs`
  under NodeNext resolution.
- `infra/rds-env.sh` the sourced entry point developers actually run.
- `infra/rds-bootstrap.sh` creates the shared `andpay` database and applies
  every context's migrations to it.
- `test/db-loopback.ts` the shared guard predicate and its message.
- `test/db-url-resolver.test.ts` tests for `infra/db-url.mjs`.
- `test/db-loopback.test.ts` tests for the guard predicate.

**Modified:**

- `test/db-tests-ran.setup.ts` gains the guard, so it fires once per
  database-backed test file, before any `beforeEach` truncation.
- `vitest.global-teardown.ts` gains the same guard as defence in depth.
- `test/architecture.test.ts` gains the committed-endpoint guard.
- `infra/db.sh` gains one echo naming the host it is about to migrate.
- `.env.example` gains the shared-RDS key shape, with no values.
- `docs/plan/CORPUS_SUBMISSION_2026-08-17_SHARED_DEV_RDS.md` has the literal
  endpoint redacted, so it can be committed without tripping the new guard.
- `CLAUDE.md`, `docs/plan/phase7_demo/HARNESS_RUN.md`,
  `docs/platform_build_state.md` documentation.
- `docs/plan/phase7_demo/harness/fake-data.mjs` local only, gitignored, two
  hardcoded URLs gain an env fallback.

---

## Task 0: Prerequisites, out of band

No code. This task is a gate. Do not begin Task 1 until every box is ticked.

- [ ] **Step 1: Confirm ratification**

Bhupender has answered the four questions in Section 9 of the submission. If
he rejected the S4 deviation in favour of Secrets Manager or IAM
authentication, STOP: Task 1 changes shape and the plan needs revising.

- [ ] **Step 2: Rotate the master password**

The current password was partially exposed in a terminal transcript on
2026-08-17. Rotate it in the RDS console before anything else. This is
required regardless of whether the rest of the plan proceeds.

- [ ] **Step 3: Recreate the instance at PostgreSQL 16**

The instance runs 18.3. The compose file, CI, and Prisma 6.3.0 all target 16,
and RDS cannot downgrade an engine version in place. The instance holds only
`postgres` and `rdsadmin`, so recreate it now at 16. Tag it
`environment=development` and `data-classification=synthetic`, which is the
S13 condition recorded in Section 6 of the submission.

- [ ] **Step 4: Confirm the security group allows each developer's address**

Verify from each machine, substituting the new endpoint:

```bash
nc -z -w 5 <endpoint> 5432 && echo reachable || echo blocked
```

---

## Task 1: The URL resolver

Sole owner of `.env` parsing and URL construction. Two behaviours are load
bearing and both were found by probing the live instance: the file is parsed
literally rather than shell-sourced, and the password is percent-encoded
before it enters the URL.

**Files:**
- Create: `infra/db-url.mjs`
- Create: `infra/db-url.d.mts`
- Test: `test/db-url-resolver.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `parseEnvFile(text: string): Record<string, string>`
  - `encodeUserinfo(value: string): string`
  - `deriveUrls(env: Record<string, string | undefined>): Record<ContextUrlKey, string>`
  - `deriveAdminUrl(env: Record<string, string | undefined>): string`
  - `loadEnvFile(path?: string): Record<string, string>`
  - `CONTEXTS: readonly string[]`
  - type `ContextUrlKey` is the union of the six `<CTX>_DATABASE_URL` names.
  - CLI: `node infra/db-url.mjs` prints seven `export NAME='value'` lines,
    the six context URLs plus `ANDPAY_ADMIN_DATABASE_URL`.

- [ ] **Step 1: Write the failing test**

Create `test/db-url-resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseEnvFile, deriveUrls, deriveAdminUrl, encodeUserinfo } from '../infra/db-url.mjs'

// The real master password contained a space and a '#'. Shell-sourcing the
// file executed part of it as a command, which is how a fragment of a live
// credential reached a terminal transcript on 2026-08-17. These cases pin the
// two behaviours that prevent a repeat.
describe('.env parsing, which is literal and never shell-sourced', () => {
  it('keeps a value containing a space and a hash intact', () => {
    expect(parseEnvFile('ANDPAY_DB_PASSWORD=aB cd#efg\n').ANDPAY_DB_PASSWORD).toBe('aB cd#efg')
  })

  it('skips a whole-line comment but never treats an inline hash as one', () => {
    const env = parseEnvFile('# a comment\nK=v#notacomment\n')
    expect(env.K).toBe('v#notacomment')
    expect(env['# a comment']).toBeUndefined()
  })

  it('strips one layer of matched quotes and keeps quotes inside the value', () => {
    expect(parseEnvFile('K="a\'b"\n').K).toBe("a'b")
    expect(parseEnvFile('K=plain\n').K).toBe('plain')
  })

  it('keeps a value containing an equals sign', () => {
    expect(parseEnvFile('K=a=b=c\n').K).toBe('a=b=c')
  })

  it('tolerates CRLF line endings', () => {
    expect(parseEnvFile('K=v\r\n').K).toBe('v')
  })
})

describe('url derivation', () => {
  const env = {
    ANDPAY_DB_HOST: 'db.example.com',
    ANDPAY_DB_USER: 'mtms_dev',
    ANDPAY_DB_PASSWORD: 'aB cd#efg',
  }

  it('percent-encodes the password so the url parses back to the original', () => {
    const parsed = new URL(deriveUrls(env).IDENTITY_DATABASE_URL)
    expect(decodeURIComponent(parsed.password)).toBe('aB cd#efg')
    expect(parsed.hostname).toBe('db.example.com')
  })

  it('requires TLS on every derived url', () => {
    for (const url of Object.values(deriveUrls(env))) {
      expect(url).toContain('sslmode=require')
    }
  })

  it('derives exactly one url per context, each pinned to its own schema', () => {
    const urls = deriveUrls(env)
    expect(Object.keys(urls).sort()).toEqual([
      'ANALYTICS_DATABASE_URL',
      'AUTH_DATABASE_URL',
      'FULFILLMENT_DATABASE_URL',
      'IDENTITY_DATABASE_URL',
      'ORCHESTRATOR_DATABASE_URL',
      'TMS_DATABASE_URL',
    ])
    expect(urls.TMS_DATABASE_URL).toContain('?schema=tms&')
  })

  it('defaults the database name and port, and honours an override', () => {
    expect(deriveUrls(env).TMS_DATABASE_URL).toContain('@db.example.com:5432/andpay?')
    const overridden = deriveUrls({ ...env, ANDPAY_DB_PORT: '6543', ANDPAY_DB_NAME: 'other' })
    expect(overridden.TMS_DATABASE_URL).toContain('@db.example.com:6543/other?')
  })

  it('points the admin url at the maintenance database, never at andpay', () => {
    expect(deriveAdminUrl(env)).toContain('/postgres')
    expect(deriveAdminUrl(env)).not.toContain('/andpay')
  })

  it('throws naming every missing key at once', () => {
    expect(() => deriveUrls({ ANDPAY_DB_HOST: 'h' })).toThrow(/ANDPAY_DB_USER, ANDPAY_DB_PASSWORD/)
  })

  it('encodes the characters encodeURIComponent leaves alone, so no quote survives into a shell line', () => {
    expect(encodeUserinfo("a'b(c)*!")).toBe('a%27b%28c%29%2A%21')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project node test/db-url-resolver.test.ts`
Expected: FAIL, cannot resolve `../infra/db-url.mjs`.

- [ ] **Step 3: Write the implementation**

Create `infra/db-url.mjs`:

```js
// Sole owner of turning the four .env primitives into connection URLs.
//
// TWO BEHAVIOURS ARE LOAD BEARING, both learned from the live instance on
// 2026-08-17.
//
// 1. This parses .env LITERALLY and never shell-sources it. Passwords
//    legitimately contain spaces, '#', '$' and quotes. A `. ./.env` executes
//    them: that is how a fragment of a live password reached a terminal
//    transcript.
// 2. The password is PERCENT-ENCODED before it enters the URL. A raw '#'
//    begins a URL fragment and silently truncates the connection string, so
//    the failure is a confusing connect error rather than a parse error.
//
// This file is deliberately dependency-free and plain ESM so that bash, the
// gitignored demo harness, and the typed test suite can all use one
// implementation. Types live alongside in db-url.d.mts.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONTEXTS = ['identity', 'tms', 'fulfillment', 'orchestrator', 'auth', 'analytics']

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export function parseEnvFile(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    // The value is NOT trimmed: trailing whitespace can be part of a password.
    let value = line.slice(eq + 1)
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// encodeURIComponent leaves !'()* unescaped. They are legal in a URL userinfo
// field, but a surviving quote would break the `export NAME='value'` lines the
// CLI emits, so the RFC 3986 unreserved set is enforced instead.
export function encodeUserinfo(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function credentials(env) {
  const missing = []
  if (!env.ANDPAY_DB_HOST) missing.push('ANDPAY_DB_HOST')
  if (!env.ANDPAY_DB_USER) missing.push('ANDPAY_DB_USER')
  if (!env.ANDPAY_DB_PASSWORD) missing.push('ANDPAY_DB_PASSWORD')
  if (missing.length > 0) {
    throw new Error(
      `.env is missing required keys: ${missing.join(', ')}. ` +
        'See .env.example for the shape. Never commit the file.',
    )
  }
  return {
    host: env.ANDPAY_DB_HOST,
    port: env.ANDPAY_DB_PORT || '5432',
    database: env.ANDPAY_DB_NAME || 'andpay',
    auth: `${encodeUserinfo(env.ANDPAY_DB_USER)}:${encodeUserinfo(env.ANDPAY_DB_PASSWORD)}`,
  }
}

export function deriveUrls(env) {
  const { host, port, database, auth } = credentials(env)
  const out = {}
  for (const ctx of CONTEXTS) {
    out[`${ctx.toUpperCase()}_DATABASE_URL`] =
      `postgresql://${auth}@${host}:${port}/${database}?schema=${ctx}&sslmode=require`
  }
  return out
}

// The maintenance database, used ONLY to CREATE DATABASE during bootstrap.
export function deriveAdminUrl(env) {
  const { host, port, auth } = credentials(env)
  return `postgresql://${auth}@${host}:${port}/postgres?sslmode=require`
}

export function loadEnvFile(path = join(REPO_ROOT, '.env')) {
  if (!existsSync(path)) {
    throw new Error(`no .env at ${path}. Copy the shared-RDS block from .env.example and fill it in.`)
  }
  return parseEnvFile(readFileSync(path, 'utf8'))
}

// CLI mode: emit shell export lines for infra/rds-env.sh to eval. Values are
// percent-encoded above, so no quote can survive to break the single quoting.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = loadEnvFile()
  const lines = Object.entries(deriveUrls(env)).map(([k, v]) => `export ${k}='${v}'`)
  lines.push(`export ANDPAY_ADMIN_DATABASE_URL='${deriveAdminUrl(env)}'`)
  console.log(lines.join('\n'))
}
```

Create `infra/db-url.d.mts`:

```ts
// Hand-written types for infra/db-url.mjs. The implementation is plain ESM so
// bash, the gitignored demo harness, and the typed suites can share one copy;
// this file is what lets test/ import it under NodeNext resolution.
export type ContextUrlKey =
  | 'IDENTITY_DATABASE_URL'
  | 'TMS_DATABASE_URL'
  | 'FULFILLMENT_DATABASE_URL'
  | 'ORCHESTRATOR_DATABASE_URL'
  | 'AUTH_DATABASE_URL'
  | 'ANALYTICS_DATABASE_URL'

export declare const CONTEXTS: readonly string[]
export declare function parseEnvFile(text: string): Record<string, string>
export declare function encodeUserinfo(value: string): string
export declare function deriveUrls(env: Record<string, string | undefined>): Record<ContextUrlKey, string>
export declare function deriveAdminUrl(env: Record<string, string | undefined>): string
export declare function loadEnvFile(path?: string): Record<string, string>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project node test/db-url-resolver.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Verify the CLI and typecheck**

```bash
pnpm typecheck
```

Expected: clean. Then, with a `.env` present:

```bash
node infra/db-url.mjs | sed 's/:[^:@]*@/:REDACTED@/'
```

Expected: seven `export` lines, each ending in `sslmode=require`.

- [ ] **Step 6: Commit**

```bash
git add infra/db-url.mjs infra/db-url.d.mts test/db-url-resolver.test.ts
git commit -m "feat(infra): derive database urls from .env without shell-sourcing it

Parses .env literally and percent-encodes the password before building each
url. A password containing a space and a '#' broke both assumptions on the
live instance: shell-sourcing executed part of it, and a raw '#' would have
truncated every connection string at the URL fragment.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The loopback guard

The centre of the design. The gate truncates the four domain schemas and
deletes auth rows at the end of every run, and 115 suites truncate in
`beforeEach` during it. Pointed at the shared dataset it destroys the team's
data. The rule is stated as an allowlist, "tests may only ever touch
localhost", so it protects every future instance and not just this one.

**Files:**
- Create: `test/db-loopback.ts`
- Test: `test/db-loopback.test.ts`
- Modify: `test/db-tests-ran.setup.ts`
- Modify: `vitest.global-teardown.ts:366` (the `teardown` function)

**Interfaces:**
- Consumes: nothing from Task 1. The guard reads `process.env` directly,
  because it must catch a non-loopback URL no matter how it was set.
- Produces:
  - `SCOPED_URL_VARS: readonly string[]`
  - `isLoopbackUrl(url: string): boolean`
  - `nonLoopbackVars(env?: NodeJS.ProcessEnv): string[]`
  - `loopbackViolationMessage(offenders: string[]): string`

- [ ] **Step 1: Write the failing test**

Create `test/db-loopback.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isLoopbackUrl, nonLoopbackVars, loopbackViolationMessage, SCOPED_URL_VARS } from './db-loopback.js'

describe('loopback detection', () => {
  it('accepts every form of the local docker Postgres', () => {
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms')).toBe(true)
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@127.0.0.1:5432/andpay?schema=tms')).toBe(true)
    expect(isLoopbackUrl('postgresql://andpay:andpay_dev@[::1]:5432/andpay?schema=tms')).toBe(true)
  })

  it('rejects a shared RDS endpoint', () => {
    expect(isLoopbackUrl('postgresql://u:p@db.abc123.ap-south-1.rds.amazonaws.com:5432/andpay?schema=tms')).toBe(false)
  })

  it('is not fooled by a loopback-looking password, user, or database name', () => {
    expect(isLoopbackUrl('postgresql://localhost:localhost@evil.example.com:5432/localhost')).toBe(false)
  })

  it('fails closed on an unparseable url', () => {
    expect(isLoopbackUrl('not a url')).toBe(false)
    expect(isLoopbackUrl('')).toBe(false)
  })
})

describe('offender detection across the environment', () => {
  it('returns nothing when every variable is unset, which is the normal local case', () => {
    expect(nonLoopbackVars({})).toEqual([])
  })

  it('ignores an empty string, which is an unset variable in practice', () => {
    expect(nonLoopbackVars({ TMS_DATABASE_URL: '' })).toEqual([])
  })

  it('names every offending variable, not just the first', () => {
    const offenders = nonLoopbackVars({
      TMS_DATABASE_URL: 'postgresql://u:p@shared.rds.amazonaws.com:5432/andpay?schema=tms',
      AUTH_DATABASE_URL: 'postgresql://u:p@shared.rds.amazonaws.com:5432/andpay?schema=auth',
      IDENTITY_DATABASE_URL: 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity',
    })
    expect(offenders.sort()).toEqual(['AUTH_DATABASE_URL', 'TMS_DATABASE_URL'])
  })

  it('covers the outbox library test url as well as the six contexts', () => {
    expect(SCOPED_URL_VARS).toContain('OUTBOX_TEST_DATABASE_URL')
    expect(SCOPED_URL_VARS).toHaveLength(7)
  })
})

describe('the violation message', () => {
  it('names the offenders and tells the reader how to recover', () => {
    const message = loopbackViolationMessage(['TMS_DATABASE_URL'])
    expect(message).toContain('TMS_DATABASE_URL')
    expect(message).toContain('TRUNCATE')
    expect(message).toContain('pnpm db:up')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project node test/db-loopback.test.ts`
Expected: FAIL, cannot resolve `./db-loopback.js`.

- [ ] **Step 3: Write the implementation**

Create `test/db-loopback.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project node test/db-loopback.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire the guard into the per-file setup**

Modify `test/db-tests-ran.setup.ts`. Add the import beside the existing ones,
and the guard block immediately BEFORE the existing `mkdirSync` call, so a
violating run never even writes the marker:

```ts
import { nonLoopbackVars, loopbackViolationMessage } from './db-loopback.js'
```

```ts
// THE GUARD (2026-08-17, for the shared developer RDS).
//
// This file already runs once per test FILE in the `node` project, which is
// the only project whose suites talk to Postgres, so it is the earliest
// per-suite choke point available. Throwing here fails the file before its
// `beforeEach` truncation can run, which is the whole point: the teardown
// guard alone would fire only after the damage.
const offenders = nonLoopbackVars()
if (offenders.length > 0) {
  throw new Error(loopbackViolationMessage(offenders))
}
```

- [ ] **Step 6: Wire the same guard into the teardown**

Modify `vitest.global-teardown.ts`. Add to the imports:

```ts
import { nonLoopbackVars, loopbackViolationMessage } from './test/db-loopback.js'
```

Then, inside `export async function teardown()`, add this as the FIRST
statement, above the existing `ANDPAY_SKIP_TEST_TEARDOWN` check:

```ts
  // GUARD 4: NEVER TRUNCATE SHARED INFRASTRUCTURE (2026-08-17).
  //
  // Defence in depth. The per-file guard in test/db-tests-ran.setup.ts should
  // already have failed every suite before reaching here, but this function
  // owns the destructive statements, so it refuses on its own authority
  // rather than trusting a caller. Loud and non-fatal, like the rest of this
  // file: cleanup failing must never turn a green gate red.
  const offenders = nonLoopbackVars()
  if (offenders.length > 0) {
    console.error(`${TAG} ${loopbackViolationMessage(offenders)}`)
    return
  }
```

- [ ] **Step 7: Prove the guard actually fires**

This is the step that matters. A guard nobody has seen fire is a guard nobody
knows works.

```bash
TMS_DATABASE_URL='postgresql://u:p@fake.ap-south-1.rds.amazonaws.com:5432/andpay?schema=tms' \
  pnpm vitest run --project node test/architecture.test.ts 2>&1 | tail -20
```

Expected: the run FAILS with "REFUSING TO RUN", naming `TMS_DATABASE_URL`.
Confirm no truncation is reported.

Then confirm a normal run is unaffected:

```bash
pnpm vitest run --project node test/db-loopback.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add test/db-loopback.ts test/db-loopback.test.ts test/db-tests-ran.setup.ts vitest.global-teardown.ts
git commit -m "feat(test): refuse to run the gate against a non-loopback database

The gate truncates the four domain schemas and deletes auth rows, and 115
suites truncate in beforeEach. Pointed at the shared developer RDS, one run
destroys the team's dataset. Stated as an allowlist so it protects every
future instance, not just the one that exists today.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The committed-endpoint guard

What makes a plaintext `.env` survivable. Also redacts the endpoint from the
submission, which currently contains it and would trip this guard on commit.

**Files:**
- Modify: `test/architecture.test.ts` (append a new `describe` at the end)
- Modify: `docs/plan/CORPUS_SUBMISSION_2026-08-17_SHARED_DEV_RDS.md`

**Interfaces:**
- Consumes: nothing. Uses `git ls-files` so it sees exactly what a commit
  would carry.
- Produces: nothing importable.

- [ ] **Step 1: Confirm no tracked document already carries an endpoint**

The submission was redacted when this plan was written, so this should already
be clean. Verify before writing a guard that would fail on day one:

```bash
grep -rIlE '[a-z0-9][a-z0-9-]*\.[a-z0-9]{8,}\.[a-z0-9-]+\.rds\.amazonaws\.com' $(git ls-files) 2>/dev/null || echo "clean"
```

Expected: `clean`. If any file is listed, redact it before continuing. The
endpoint belongs in the team vault beside the password, not in a tracked file.
This is the guard's own rule applied to the documents that propose it.

- [ ] **Step 2: Write the failing test**

Append to `test/architecture.test.ts`:

```ts
describe('no shared-infrastructure endpoint is ever committed (S4)', () => {
  // `git ls-files` rather than a directory walk, so this sees exactly what a
  // commit would carry: gitignored files such as .env are invisible to it by
  // construction, which is the point.
  const tracked = execSync('git ls-files -z', { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0')
    .filter((p) => p !== '')

  // An RDS endpoint: <instance>.<account-suffix>.<region>.rds.amazonaws.com.
  // Anchored on the full shape so prose mentioning "rds.amazonaws.com" while
  // explaining the rule does not trip it.
  const RDS_ENDPOINT = /[a-z0-9][a-z0-9-]*\.[a-z0-9]{8,}\.[a-z0-9-]+\.rds\.amazonaws\.com/i

  it('has files to check', () => {
    expect(tracked.length).toBeGreaterThan(100)
  })

  it('no tracked file contains an RDS endpoint hostname', () => {
    const offenders: string[] = []
    for (const file of tracked) {
      const full = join(root, file)
      if (!existsSync(full)) continue
      if (statSync(full).isDirectory()) continue
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue // binary or unreadable, nothing to match
      }
      if (RDS_ENDPOINT.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('no tracked file assigns a value to the shared-RDS password key', () => {
    const offenders: string[] = []
    for (const file of tracked) {
      const full = join(root, file)
      if (!existsSync(full) || statSync(full).isDirectory()) continue
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      // `.env.example` carries the bare key with nothing after the '=', which
      // is exactly what it is for. Anything else is a committed credential.
      for (const line of text.split('\n')) {
        if (/^\s*ANDPAY_DB_PASSWORD\s*=\s*\S/.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 30)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
```

Add `execSync` to the imports at the top of the file:

```ts
import { execSync } from 'node:child_process'
```

- [ ] **Step 3: Prove the test has teeth before trusting it**

A guard that has only ever passed proves nothing. Plant a violation, confirm
the guard catches it, then remove it:

The probe hostname is ASSEMBLED AT RUNTIME rather than written out. A literal
endpoint in this plan would be caught by the very guard it is testing, which
is a pleasing confirmation that the rule works but an annoying way to fail a
build.

```bash
printf 'host: probe.%s.%s.%s\n' 'abcdefgh12' 'ap-south-1' 'rds.amazonaws.com' > ./guard-probe.md
git add ./guard-probe.md
pnpm vitest run --project node test/architecture.test.ts -t "no tracked file contains an RDS endpoint"
```

Expected: FAIL, listing `guard-probe.md`.

```bash
git rm -f --cached ./guard-probe.md && rm -f ./guard-probe.md
pnpm vitest run --project node test/architecture.test.ts -t "no tracked file contains an RDS endpoint"
```

Expected: PASS.

Note: `git ls-files` lists TRACKED files. A new file is invisible to the guard
until it is staged, which is why the probe above runs `git add`. Make sure both
the submission and this plan are tracked before relying on the result.

- [ ] **Step 4: Run the whole architecture suite**

Run: `pnpm vitest run --project node test/architecture.test.ts`
Expected: PASS, all existing guards plus the three new ones.

- [ ] **Step 5: Commit**

```bash
git add test/architecture.test.ts docs/plan/CORPUS_SUBMISSION_2026-08-17_SHARED_DEV_RDS.md
git commit -m "test(architecture): fail the build on a committed RDS endpoint or password

Reads git ls-files, so it sees exactly what a commit would carry and is blind
to the gitignored .env by construction. Redacts the endpoint from the
submission that proposed the rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The shell entry point and bootstrap

**Files:**
- Create: `infra/rds-env.sh`
- Create: `infra/rds-bootstrap.sh`
- Modify: `.env.example`
- Modify: `infra/db.sh`

**Interfaces:**
- Consumes: `node infra/db-url.mjs` CLI from Task 1, which prints seven
  `export` lines including `ANDPAY_ADMIN_DATABASE_URL`.
- Produces: a shell environment in which the six `<CTX>_DATABASE_URL`
  variables point at the shared RDS, which every existing consumer already
  reads.

- [ ] **Step 1: Add the key shape to `.env.example`**

Append to `.env.example`:

```
# ---------------------------------------------------------------------------
# SHARED DEVELOPER RDS (optional, spec CORPUS_SUBMISSION_2026-08-17).
#
# Copy these four keys into a LOCAL .env and fill them in. Never commit that
# file; .gitignore already covers .env, and test/architecture.test.ts fails the
# build if an endpoint or a password value is ever tracked (S4).
#
# infra/db-url.mjs derives the six <CTX>_DATABASE_URL values from these, and
# `source infra/rds-env.sh` exports them into the current shell.
#
# THE GATE NEVER USES THESE. `pnpm test` is localhost only and refuses to run
# in a shell where these are exported. Values are for portal and demo work.
ANDPAY_DB_HOST=
ANDPAY_DB_PORT=5432
ANDPAY_DB_USER=
ANDPAY_DB_PASSWORD=
ANDPAY_DB_NAME=andpay
```

- [ ] **Step 2: Write the sourced entry point**

Create `infra/rds-env.sh`:

```bash
# SOURCE this file, do not execute it:
#
#     source infra/rds-env.sh
#
# Exports the six <CTX>_DATABASE_URL values for the SHARED developer dataset,
# plus ANDPAY_ADMIN_DATABASE_URL for bootstrap. Every consumer already reads
# those variables with a localhost fallback, so nothing else needs changing.
#
# The derivation lives in infra/db-url.mjs and NOT here, because .env must be
# parsed literally: a password containing a space or a '#' is executed by a
# `. ./.env`, and a raw '#' truncates a connection string at the URL fragment.

if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo "rds-env: source this file, do not execute it: source infra/rds-env.sh" >&2
  exit 1
fi

__andpay_rds_env() {
  local root exports
  root="$(cd "$(dirname "${BASH_SOURCE[1]}")/.." && pwd)"
  if ! exports="$(node "${root}/infra/db-url.mjs")"; then
    echo "rds-env: could not derive urls from .env. See .env.example." >&2
    return 1
  fi
  eval "${exports}"
  echo "rds-env: six <CTX>_DATABASE_URL exported, pointing at the SHARED dataset."
  echo "rds-env: do NOT run pnpm test in this shell. The gate is localhost only and will refuse."
}

__andpay_rds_env
```

- [ ] **Step 3: Write the bootstrap script**

Create `infra/rds-bootstrap.sh`:

```bash
#!/usr/bin/env bash
# Create the shared `andpay` database on the RDS instance and apply every
# context's migrations to it.
#
# Idempotent: re-running creates nothing that exists and applies only new
# migrations. Roles are CLUSTER-wide in Postgres, so the six <ctx>_app login
# roles and their work roles are created once by whichever database migrates
# first; every other database's role migration is a no-op through its
# IF NOT EXISTS block.
#
# Run from the repo root:  bash infra/rds-bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

eval "$(node infra/db-url.mjs)"

DB_NAME="$(node -e 'import("./infra/db-url.mjs").then(m => process.stdout.write(m.loadEnvFile().ANDPAY_DB_NAME || "andpay"))')"

# Host only, never the credential, so this is safe to paste into a ticket.
HOST="$(node -e 'const u=new URL(process.env.ANDPAY_ADMIN_DATABASE_URL); process.stdout.write(u.hostname)')"
echo ">>> target: ${DB_NAME} on ${HOST}"
read -r -p "Apply all migrations to that database? [y/N] " reply
[ "${reply}" = "y" ] || { echo "aborted."; exit 1; }

if psql "${ANDPAY_ADMIN_DATABASE_URL}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo ">>> database ${DB_NAME} already exists"
else
  echo ">>> creating database ${DB_NAME}"
  psql "${ANDPAY_ADMIN_DATABASE_URL}" -c "CREATE DATABASE \"${DB_NAME}\""
fi

# infra/db.sh already honours an exported <CTX>_DATABASE_URL through its
# ${VAR:-default} expansion, so it needs no target flag: the exports above win.
bash ./infra/db.sh

echo "done. six schemas migrated on ${HOST}."
```

- [ ] **Step 4: Make `infra/db.sh` say where it is pointing**

Modify `infra/db.sh`. Immediately after the six `export` lines and before
`MODE="${1:-deploy}"`, insert:

```bash
# Say where this is about to write. `db.sh` silently honours an exported
# <CTX>_DATABASE_URL, which is what makes infra/rds-bootstrap.sh work, and is
# also how somebody migrates the shared instance while believing they are
# migrating docker.
echo ">>> migrating host: $(node -e 'process.stdout.write(new URL(process.env.IDENTITY_DATABASE_URL).hostname)')"
```

- [ ] **Step 5: Verify end to end**

```bash
chmod +x infra/rds-bootstrap.sh
bash -n infra/rds-env.sh && bash -n infra/rds-bootstrap.sh
```

Expected: no syntax errors. Then confirm the local path is unchanged:

```bash
pnpm db:up && bash ./infra/db.sh
```

Expected: `>>> migrating host: localhost`, then six contexts reported.

Then, in a throwaway shell, confirm the shared path and the guard together:

```bash
source infra/rds-env.sh
node -e 'console.log(new URL(process.env.TMS_DATABASE_URL).hostname)'
pnpm vitest run --project node test/db-loopback.test.ts
```

Expected: the RDS hostname printed, then the vitest run REFUSING TO RUN.
That single sequence demonstrates both halves of the design.

- [ ] **Step 6: Commit**

```bash
git add infra/rds-env.sh infra/rds-bootstrap.sh infra/db.sh .env.example
git commit -m "feat(infra): source-able env and bootstrap for the shared developer RDS

rds-env.sh exports the six urls into the current shell, which every consumer
already reads, so no application code changes. db.sh now names the host it is
about to migrate, because it silently honours exported urls.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Fix the two harness files that ignore the environment

`docs/plan/phase7_demo/harness/` is GITIGNORED, so this task produces no
commit. It is still required: without it the demo writes half its data to the
shared RDS and half to local docker, which is worse than either alone.

**Files:**
- Modify: `docs/plan/phase7_demo/harness/fake-data.mjs:87` and `:91`

**Interfaces:**
- Consumes: the exported variables from Task 4.
- Produces: nothing.

- [ ] **Step 1: Confirm the problem**

```bash
grep -n "andpay_dev@localhost" docs/plan/phase7_demo/harness/*.mjs
```

Expected: `fake-data.mjs` lines 87 and 91 hardcode the url with NO
`process.env` fallback. Every other harness file
(`operators.mjs`, `pump.mjs`, `rail.mjs`) uses `process.env[...] ?? default`.

- [ ] **Step 2: Give both lines the same fallback the rest of the harness uses**

Replace line 87:

```js
  return new PrismaClient({ datasourceUrl: 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment' })
```

with:

```js
  // Matches pump.mjs and rail.mjs. Without the env read this file wrote to
  // local docker while the rest of the harness wrote to the shared dataset.
  return new PrismaClient({
    datasourceUrl:
      process.env.FULFILLMENT_DATABASE_URL ?? 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment',
  })
```

Replace line 91 the same way, using `process.env.TMS_DATABASE_URL` and the
`?schema=tms` default.

- [ ] **Step 3: Verify**

```bash
grep -c "process.env" docs/plan/phase7_demo/harness/fake-data.mjs
```

Expected: at least 2.

```bash
source infra/rds-env.sh && node -e "
  const m = process.env.FULFILLMENT_DATABASE_URL
  console.log(new URL(m).hostname)
"
```

Expected: the RDS hostname, confirming the variable the file now reads is set.

- [ ] **Step 4: No commit**

The harness is gitignored. Record the change in `HARNESS_RUN.md` in Task 6
instead, so the next person who recreates the harness knows to apply it.

---

## Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/plan/phase7_demo/HARNESS_RUN.md`
- Modify: `docs/platform_build_state.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing importable.

- [ ] **Step 1: Add a section to `CLAUDE.md`**

Under the `## Commands` section, after the existing code block, add:

```markdown
### The shared developer database

`infra/docker-compose.dev.yml` remains the ONLY database the test gate ever
touches. A shared AWS RDS Postgres in ap-south-1 holds the common dataset for
portal and demo work.

    source infra/rds-env.sh     # export the six urls for the SHARED dataset
    bash infra/rds-bootstrap.sh # first time only: create and migrate it

Credentials come from a gitignored `.env` holding four keys; see
`.env.example`. `infra/db-url.mjs` derives the urls, parsing the file
literally and percent-encoding the password, because a password containing a
space or a `#` breaks both a shell `source` and a raw connection string.

`pnpm test` REFUSES to run in a shell that has sourced `rds-env.sh`. The gate
truncates the four domain schemas and deletes auth rows on every run, so it
may only ever talk to localhost. The guard lives in `test/db-loopback.ts` and
fires from both `test/db-tests-ran.setup.ts` and `vitest.global-teardown.ts`.

The instance is developer-only and synthetic-data-only. It runs as the table
owner and is therefore RLS-exempt, which is the same posture as local docker
and the subject of go-live blocker E-3. Anything beyond developer use reopens
E-3 first (S13).
```

- [ ] **Step 2: Add a section to `docs/plan/phase7_demo/HARNESS_RUN.md`**

Add, near the run instructions:

```markdown
### Running the harness against the shared dataset

`source infra/rds-env.sh` before booting `serve.mjs`, and every harness file
that reads `process.env.<CTX>_DATABASE_URL` follows automatically.

ONE LOCAL EDIT IS REQUIRED and cannot be committed, because this directory is
gitignored. `fake-data.mjs` hardcodes two urls with no environment fallback,
unlike `pump.mjs`, `rail.mjs` and `operators.mjs`. Give both the same
`process.env.<CTX>_DATABASE_URL ?? <localhost default>` shape, or the fake
data lands in local docker while everything else lands on the shared
instance.
```

- [ ] **Step 3: Record the state change in `docs/platform_build_state.md`**

The file is a chronological list of dated bullets, each recording what landed
and how it was verified. Append one, substituting the real date and the
observed migration count:

```markdown
- 2026-08-DD: SHARED DEVELOPER RDS LANDED (corpus submission
  2026-08-17_SHARED_DEV_RDS, ratified by Bhupender). One PostgreSQL 16
  instance in ap-south-1 holds a single `andpay` database with the six
  per-context schemas, for portal and demo work only. No application code
  changed: the three edges and the demo harness already read
  `process.env.<CTX>_DATABASE_URL` with a localhost fallback, so
  `source infra/rds-env.sh` is sufficient. Credentials derive from four keys
  in a gitignored `.env` through `infra/db-url.mjs`, which parses the file
  literally and percent-encodes the password (both learned from a live
  password containing a space and a `#`: shell-sourcing executed part of it,
  and a raw `#` would truncate every connection string at the URL fragment).
  THE GATE DID NOT MOVE and cannot: measured 57.59 ms per round-trip against
  0.05 ms on local docker, which across 240 serially-run test files would add
  roughly half an hour of pure network wait. `test/db-loopback.ts` enforces
  that, firing from both `test/db-tests-ran.setup.ts` (per test file, before
  any `beforeEach` truncation) and `vitest.global-teardown.ts` (before any
  TRUNCATE). VERIFIED: full CI sequence green and still local; the guard
  demonstrated FAILING a run in a shell that had sourced `rds-env.sh`; 78
  migrations applied across six contexts on the shared instance; the demo
  booted against it and a second developer saw the same rows.
  S13 CONDITION, binding: this instance is DEVELOPER-ONLY and
  SYNTHETIC-DATA-ONLY. Connections run as the table owner and are therefore
  RLS-exempt, the same posture as local docker and the subject of go-live
  blocker E-3. Any promotion beyond developer use reopens E-3 first. The
  `<ctx>_app` roles were confirmed to enforce RLS correctly when they are
  given passwords, so that path is real and unblocked.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/plan/phase7_demo/HARNESS_RUN.md docs/platform_build_state.md
git commit -m "docs: record the shared developer RDS and the localhost-only gate rule

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Full verification

No new files. This is the acceptance gate for the whole plan.

- [ ] **Step 1: The gate is still green and still local**

In a shell that has NOT sourced `rds-env.sh`:

```bash
pnpm db:up && bash ./infra/db.sh && pnpm -r build && pnpm lint && pnpm typecheck && pnpm test
```

Expected: `>>> migrating host: localhost`, then all green. This is the exact
CI sequence from `.github/workflows/ci.yml`.

- [ ] **Step 2: The guard fires against a shared host**

```bash
source infra/rds-env.sh
pnpm vitest run --project node test/architecture.test.ts 2>&1 | tail -20
```

Expected: FAIL with "REFUSING TO RUN", naming the offending variables.
Confirm the shared dataset is untouched afterwards.

- [ ] **Step 3: The shared dataset is reachable and migrated**

```bash
source infra/rds-env.sh
psql "$ANDPAY_ADMIN_DATABASE_URL" -c "\l" | grep andpay
psql "$(node -e 'process.stdout.write(process.env.IDENTITY_DATABASE_URL)')" \
  -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;"
```

Expected: the `andpay` database listed, and a non-zero applied-migration
count. Across all six contexts the total applied should be 78.

- [ ] **Step 4: The demo boots against the shared dataset**

```bash
source infra/rds-env.sh
bash scripts/demo.sh
```

Expected: the ops portal loads and shows data from the shared instance. Check
the consumer log for zero retry or DLQ lines.

- [ ] **Step 5: A second developer sees the same data**

Have Bhupender run steps 3 and 4 on his machine after filling in his own
`.env`. Expected: the same rows. This is the entire point of the change and
the only step that actually proves it.

- [ ] **Step 6: Confirm no secret was committed**

```bash
git log --oneline -8
pnpm vitest run --project node test/architecture.test.ts -t "no shared-infrastructure endpoint"
git check-ignore -v .env
```

Expected: the guard passes, and `.env` reports as ignored.

---

## Notes for the executor

- **Task 0 is a real gate.** The submission is unratified. If Bhupender
  requires Secrets Manager or IAM authentication instead of a plaintext
  `.env`, Task 1 changes shape: the resolver keeps its parsing and encoding
  responsibilities but gains a fetch step, and `.env` holds a profile name
  rather than a password. Tasks 2, 3, 5 and 6 are unaffected.
- **No application code is modified by this plan.** If you find yourself
  editing anything under `apps/*/src` or `services/*/src`, stop: the design
  works precisely because those files already read the environment.
- **The one number worth re-checking** is 78 applied migrations in Task 7
  Step 3. If it differs, a migration was added after 2026-08-17 and that is
  expected, not a failure.
