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

## Stack defaults (spec-level, swappable per service later)

- Node 22, TypeScript strict, pnpm workspaces.
- Services will be NestJS; portals React plus Vite; per-context Postgres via
  Prisma with the outbox written in the same transaction. These arrive in later
  specs; nothing service-shaped exists yet.
- Tests: vitest.
- None of the above is an architectural invariant. The invariants live in the
  corpus (docs/architecture_rules.md).

## How work arrives

- Each service and app directory will carry its own handoff spec as `SPEC.md`.
- Claude Code implements specs only. It does not design architecture here.
- The first spec (platform bootstrap) is `docs/handoff_spec_01_platform_bootstrap.md`.

## Corpus pointers (team copies)

- `docs/architecture_rules.md` is the enforcement layer: invariants, guardrails,
  the risk register, and the new-component gate. Read it before any design review.
- `docs/handoff_spec_01_platform_bootstrap.md` is the spec this repository was
  bootstrapped from.
- `docs/platform_build_state.md` is the repo side build ledger: what has landed
  here and its verification. The authoritative build state lives in the corpus.
- The remaining corpus files (architure_context.md, chapters 04 to 07,
  00_intake_and_build_protocol.md, platform_build_state.md) live in the
  architecture chat and should be copied into `docs/` as the team needs them.

## Repository shape

- `packages/` shared libraries: `@andpay/ids` (typed public IDs), `@andpay/keys`
  (the 06.A idempotency key grammar), `@andpay/outbox` (transactional outbox and
  consumer inbox).
- `services/` per-context services (identity, tms, fulfillment). Each carries a
  `prisma/` project pinned to its own schema (outbox and inbox only for now);
  domain tables arrive with each service spec.
- `apps/` portals (ops-portal, vendor-portal), empty until their specs arrive.
- `infra/` local dev infrastructure: `docker-compose.dev.yml` (one postgres:16)
  and `db.sh` (migrate plus generate).
- `docs/` corpus copies for the team.

## Local development

- Database: `pnpm db:up` starts one postgres:16 with a schema per context. Then
  `bash ./infra/db.sh` applies migrations and generates the per-context Prisma
  clients, and `pnpm --filter @andpay/outbox db:push:test` sets up the outbox
  library's own test schema.
- Schema-per-context is a build-time choice; the physical split to an
  instance-per-context later is a connection-string change only. Never write a
  cross-schema query, join, or FK (C4, T1, T7).
- Tests: `pnpm test` runs everything. The `@andpay/outbox` tests are integration
  tests and need the database up first (`pnpm db:up`). `pnpm lint` and
  `pnpm typecheck` do not need the database.
- Generated Prisma clients live under `services/*/generated` and
  `packages/*/generated` and are gitignored; regenerate them with the commands
  above.
