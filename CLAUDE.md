# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AndPayments Platform

A microservices payments platform. Its architecture is governed by an external
corpus (the architecture chat and its files); decisions are cited by number
(for example Decision 118, I4, S4, C2). This repository implements those
decisions. It never invents architecture. When a requirement seems to need
something a spec does not grant, STOP and escalate to the architecture chat.

## DO-NOT list (repo-wide, binding on every change)

- Never invent an ID prefix, event topic, or entity; they come only from the
  architecture corpus by decision.
- No product calls a product; no cross-context DB reads; contexts integrate
  through facts and rails only (C2, C4, T1, T7).
- No direct ledger writes ever (M4); this product has NO money surface at all
  (S20).
- merchant_id, vendor scope, and mode come from the authenticated principal,
  never a request body (M7, S16, 105c).
- Secrets never in code, config files, logs, events, or IDs (S4); redact before
  the first log line (5c).
- No em-dashes or en-dashes in any document, comment, or commit message; use
  periods or commas.
- When a requirement seems to need something this spec does not grant, STOP and
  escalate to the architecture chat; do not improvise.

## Stack

- Node 22, TypeScript strict, pnpm 10 workspaces (`packages/*`, `services/*`,
  `apps/*`), ESM throughout.
- Services and edges are NestJS; portals are React plus Vite; per-context
  Postgres via Prisma with the outbox written in the same transaction.
- Tests: vitest.
- None of the above is an architectural invariant. The invariants live in the
  corpus (docs/architecture_rules.md).

## How work arrives

- Work arrives as numbered handoff specs. Claude Code implements specs only; it
  does not design architecture here.
- `docs/handoff_spec_01_platform_bootstrap.md` is the spec this repository was
  bootstrapped from. Later specs (02 through 14b) are recorded by their
  verification files under `evidence/spec_*_evidence.md`, which is the fastest
  way to find out what a spec required and how it was proven.
- `docs/plan/` carries the working ledger: PHASE*_DECISIONS.md, OPEN_ITEMS.md,
  GO_LIVE_BLOCKERS.md, OUTSTANDING*.md and dated RESUME_PROMPT files. Read the
  latest RESUME_PROMPT before picking up in-flight work.

## Corpus pointers (team copies)

- `docs/architecture_rules.md` is the enforcement layer: invariants, guardrails,
  the risk register, and the new-component gate. Read it before any design review.
- `docs/platform_build_state.md` is the repo side build ledger: what has landed
  here and its verification. The authoritative build state lives in the corpus.
- `docs/architure_context.md` (spelling is as-is) records what was decided and
  why, with history.
- `docs/design/ANDPAYMENTS-DESIGN-SYSTEM.md` governs portal UI.

## Architecture

Five bounded contexts, each with its own Postgres schema, its own Prisma client,
and no path to another context's data except facts on the bus.

**`services/` are libraries, not processes.** Each exports domain logic plus its
own generated Prisma client (`@andpay/tms-service` and so on) and owns a
`prisma/` project pinned to its schema. Nothing in `services/` listens on a
port.

- `identity`, `tms`, `fulfillment`, `analytics` are the four domain (fact)
  contexts. `orchestrator` holds saga state only (schema, no `src/`).
- `auth` is the sole secret-holder (spec 04): D121 stores, all D3 token and
  class-6 credential issuance and lifecycle, the hash-chained `authz_audit`
  ledger.

**`apps/` are the processes.** Edges are the only HTTP surface:

- `auth-edge` (internal login, MFA, step-up, session), `vendor-auth-edge`
  (vendor operator login and provisioning), `ops-edge` (operator reads, writes,
  reports), `tenant-edge` (tenant reads and reports), `vendor-edge` (vendor
  intake, pull, return, courier status).
- `relay` drains each context's outbox and publishes to Kafka, and does nothing
  else. `consumer` is one image run once per context via `CONSUMER_CONTEXT`, so
  a slow consumer can never run inside the relay's claim transaction.
  `scheduler` fires due `max_wait` batching timers on a poll loop.
- `ops-portal` and `vendor-portal` are the Vite SPAs.

**`packages/` are the shared rails:** `@andpay/ids` (typed public IDs),
`@andpay/keys` (06.A idempotency key grammar), `@andpay/outbox` (transactional
outbox and consumer inbox), `@andpay/envelope` (E4 codec), `@andpay/bus` (Kafka
publisher, schema-registry port, retry ladder, topic provisioning),
`@andpay/engine` (D77 saga engine), `@andpay/authz` (secret-free D3 verify,
`api_`/`apsk_` resolve, D2 two-gate evaluator), `@andpay/edge` (error filters,
CORS, security headers, principal resolve, authorize-audit), `@andpay/audit`
(hash-chain construction), `@andpay/bank-qr` (the one known bank UPI-QR export
defect: TMS DETECTS it to report per-file evidence, fulfillment CORRECTS it at
the artifact boundaries, one rule so the two cannot drift).

### The database scope contract (D-3, specs 10b/10c/10d)

Every context read or write goes through its own `read-context.ts` /
`write-context.ts` before any SQL, inside the same transaction:

- `enterReadScope(tx, role, programIds)` sets `SET LOCAL ROLE <ctx>_read` and
  binds `app.program_ids`; RESTRICTIVE RLS then gates every SELECT, fail-closed
  on an unset or empty value.
- `enterWriteScope(tx, role, programId)` sets `<ctx>_write` and binds
  `app.program_id`; `*_scoped WITH CHECK` gates each write.
- The role name is always a compile-time constant, safe to inline. The program
  scope is always resolved server-side from the target aggregate or from
  verified claims, never from a request body (M7, S16, D99), and always bound as
  a parameter, never concatenated.

### Infrastructure

`infra/docker-compose.dev.yml` runs one postgres:16 (schema per context) and one
Redpanda (Kafka API plus a Confluent-compatible schema registry) as the local
stand-in for AWS MSK plus Glue. `infra/aws` is CDK config-as-code applied out of
band; topics are provisioned there, never created at runtime (S23).

Schema-per-context is a build-time choice; the physical split to an
instance-per-context later is a connection-string change only. Never write a
cross-schema query, join, or FK (C4, T1, T7).

## Commands

```bash
pnpm db:up                                  # postgres + redpanda, waits healthy
bash ./infra/db.sh                          # migrate deploy + generate, all six contexts
bash ./infra/db.sh dev <name>               # author a new migration instead
pnpm --filter @andpay/outbox db:push:test   # outbox library's own test schema
pnpm -r build                               # REQUIRED before tests: @andpay/* resolve via dist
pnpm lint && pnpm typecheck                 # no database needed
pnpm test                                   # vitest run --typecheck, everything
```

CI runs exactly that sequence (`.github/workflows/ci.yml`); reproduce a CI
failure by running it in the same order.

Single test file or single test:

```bash
pnpm vitest run test/architecture.test.ts
pnpm vitest run --project node services/tms/test/foo.test.ts
pnpm vitest run --project ops-portal -t "renders the upload page"
```

Generated Prisma clients live under `services/*/generated` and
`packages/*/generated` and are gitignored. If a suite fails on a missing
`generated/client`, run `bash ./infra/db.sh`.

### Local first, then sync (RULE, 20 Aug 2026)

**All development work runs against LOCAL docker.** Feature branches never point
at the shared RDS. The shared instance is a downstream mirror, refreshed only
after work lands on `main`:

1. Develop and demo against local docker (`pnpm db:up`, then plain
   `bash scripts/demo.sh` with NO `source infra/rds-env.sh`).
2. Before merging: pull `main`, resolve conflicts, run the gate.
3. Merge to `main`.
4. THEN sync the shared RDS, so `main`'s code and the shared database are the
   one default everybody works from:

       pnpm rds:sync            # DRY RUN: what would be applied
       pnpm rds:sync --apply    # apply it

**SCHEMA ONLY. The shared data is never touched** (Rahul, 20 Aug 2026).
`infra/rds-sync.sh` runs `prisma migrate deploy` and nothing else: no seed, no
truncate, no `migrate dev`, no reset. Refreshing the shared demo dataset is a
separate, explicitly destructive decision that needs its own go-ahead.

The script enforces the rule rather than trusting memory: it refuses off `main`,
refuses with uncommitted migrations, refuses when the checkout is behind
`origin/main`, refuses a loopback host, and derives the urls into its own
process so the calling shell is never poisoned for `pnpm test`. It defaults to a
dry run because "schema only" is not the same as "cannot lose data": a migration
may carry `DROP COLUMN` or `DELETE FROM`, so the dry run scans the pending SQL
and names every destructive statement before you decide.

Other developers stay in sync by pulling `main` and running `bash ./infra/db.sh`
against their own local docker. Only the shared instance goes through
`rds:sync`.

Two consequences worth stating, because both have already bitten:

- A migration applied to a database from an UNMERGED branch leaves that
  database ahead of `main`. On 20 Aug the local `andpay` carried
  `20260819061949_damage_replacement_raised_marker` from the unmerged
  `damage-flow-edge-case` branch. `migrate deploy` tolerates an extra applied
  row; `migrate dev` wants to reset. Run `prisma migrate status` per context
  before assuming a database matches the branch you are on.
- The shared RDS can be AHEAD of `main` from before this rule existed. It
  already carries the three `feature/bank-master-hierarchy` migrations
  (`20260820023159_tenant_aggregator`,
  `20260820120000_backfill_default_aggregators`, and tms
  `20260820052713_aggregator_projection`), applied by hand on 19 and 20 Aug so
  the 93-bank import could run there. `rds:sync` will therefore report nothing
  pending when that branch merges. Being ahead is benign for `migrate deploy`;
  the point of the rule is that it stops happening.

### The shared developer database

`infra/docker-compose.dev.yml` remains the ONLY database the test gate ever
touches. A shared AWS RDS Postgres in ap-south-1 holds the common dataset for
portal and demo work, refreshed from local per the rule above.

    source infra/rds-env.sh     # export the six urls for the SHARED dataset
    bash infra/rds-bootstrap.sh # first time only: create and migrate it

Bootstrapped 2026-08-17. As of 20 Aug 2026 all 84 migrations are applied across
the six schemas on all three databases (local `andpay`, local `andpay_test`, and
the shared RDS) and the dataset is live. The instance runs PostgreSQL 18.3,
which is fine. An earlier note here called for recreating it at 16 on the belief
that Prisma predated 18; the installed client is 6.19.3, not the 6.3.0 floor
declared in `package.json`, and it applied every migration cleanly.

Credentials come from a gitignored `.env` holding four keys; see
`.env.example`. `infra/db-url.mjs` derives the urls, parsing the file
literally and percent-encoding the password, because a password containing a
space or a `#` breaks both a shell `source` and a raw connection string.

`pnpm test` REFUSES to run in a shell that has sourced `rds-env.sh`. The gate
truncates the four domain schemas and deletes auth rows on every run, so it
may only ever talk to localhost. The guard lives in `test/db-loopback.ts` and
fires from both `test/db-tests-ran.setup.ts` and `vitest.global-teardown.ts`.
That guard bounds WHICH HOST the gate may reach; `vitest.db-target.ts` bounds
which local DATABASE it may destroy (`andpay_test`, never `andpay`). Both apply.

The instance is developer-only and synthetic-data-only. It runs as the table
owner and is therefore RLS-exempt, which is the same posture as local docker
and the subject of go-live blocker E-3. Anything beyond developer use reopens
E-3 first (S13).

## Testing contract

- **The gate owns its own database, `andpay_test`, and never touches `andpay`**
  (19 Aug 2026). Create it once with `bash infra/db-test-bootstrap.sh`, and
  re-run that after pulling new migrations. `vitest.db-target.ts` is the single
  definition of the target: `vitest.config.ts` injects it as the node project's
  `test.env`, and `vitest.global-teardown.ts` imports it directly because
  `globalSetup` runs in vitest's main process where that env does not apply.
  Read that file's header before changing any of it; `test/db_test_isolation.test.ts`
  asserts the three parts still agree.

  WHY IT EXISTS. Every DB-backed suite resolves its connection as
  `process.env.<CTX>_DATABASE_URL ?? '...localhost:5432/andpay?schema=<ctx>'`,
  and `.env` defines the `ANDPAY_DB_*` parts rather than those six variables, so
  in a normal shell every suite fell through to its hardcoded fallback and the
  destructive gate ran against the database the local demo lives in. It wiped
  the seeded dataset on every `pnpm test`, and on any `--project node` run
  including a single file that opens no connection. The per-file marker in
  `test/db-tests-ran.setup.ts` cannot detect that, so the separate database, not
  the marker, is what protects demo data. The fallbacks in the suites are left
  pointed at `andpay` on purpose: they are a loud last resort for a path that
  does not load the vitest config.
- Most suites are integration tests against the real local Postgres, so
  `fileParallelism` is false and every file runs serially. `pnpm db:up` first.
- Three vitest projects: `node` (packages/services/apps plus root `test/`, node
  env, with a `*.test-d.ts` typecheck pass), `ops-portal` and `vendor-portal`
  (jsdom plus the react transform, isolated so jsdom never leaks into the node
  suites).
- `vitest.global-teardown.ts` runs ONCE after the whole gate and truncates the
  four domain schemas OF `andpay_test` (see above; it consults no environment
  variable, so no shell can redirect it). Read its header before touching it: `auth` is never
  truncated (scoped DELETE preserving the `ops.admin` demo login), the
  hash-chained `authz_audit` and the auth `outbox` are never trimmed,
  `tms.damage_reason` and `fulfillment.bank_composition_config` are preserved
  master data, and `orchestrator` is untouched. Set
  `ANDPAY_SKIP_TEST_TEARDOWN=1` to inspect what a failing test left behind.
- Per-suite `beforeEach` truncation is still required; the global teardown
  guarantees a clean database AFTER the run, not isolation during it.
- Root `test/` holds the cross-cutting guards. `architecture.test.ts` is a
  static net that fails the build on a cross-schema name, a mutated
  `search_path`, a foreign context's URL, or an import of another context's
  client. Others cover write-plane C4, tenant RLS fail-closed, audience
  isolation across edges, audit-chain end to end, and residency. Treat a failure
  there as an invariant breach, not a flaky test.
- A run of `pnpm test` truncates the shared dev database, so demo state must be
  reseeded afterwards.

## Local demo harness

`docs/plan/phase7_demo/harness/` (gitignored, never moved under
`apps/ops-portal/`, where a no-demo-bridge guard scans). `serve.mjs` co-boots
auth-edge on :3000 and ops-edge on :3001 in one process with one shared
ephemeral ES256 signer, because auth-edge exposes no JWKS endpoint and mints a
fresh key each boot, so the two cannot interoperate as separate processes.
`seed-data.mjs` is idempotent, `totp.mjs` prints the current code. Run details
and the demo credentials are in `docs/plan/phase7_demo/HARNESS_RUN.md`. Harness
conveniences (in-process MFA vault, no throttle, widened TOTP window) are never
production code.
