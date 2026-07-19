# Handoff Spec 01: Platform Bootstrap (monorepo skeleton plus ID library)

> First Claude Code handoff of the AndPayments platform (Decision 118, build step 1). Template per `00_intake_and_build_protocol.md` Section D. Give Claude Code this file plus `architecture_rules.md`; it implements this spec and never invents architecture.

## 1. Identity
Not a service: the monorepo skeleton and the first shared package, `@andpay/ids`. Layer: substrate. Purpose: every later service imports typed, validated, k-sortable public IDs; the repo shape every service will live in.

## 2. Stack defaults (spec-level, swappable per service later)
Node 22, TypeScript strict, pnpm workspaces. Services will be NestJS, portals React plus Vite, per-context Postgres via Prisma with the outbox written in the same transaction (these arrive in later specs; nothing service-shaped is built in spec 01). Tests: vitest. Rationale: team continuity; none of this is an architectural invariant (Section 4 posture).

## 3. Repo structure to create
```
andpay-platform/
  CLAUDE.md
  package.json  pnpm-workspace.yaml  tsconfig.base.json  .github/workflows/ci.yml
  packages/
    ids/            <- THIS SPEC
  services/         (empty with .gitkeep: identity/ tms/ fulfillment/)
  apps/             (empty with .gitkeep: ops-portal/ vendor-portal/)
  infra/            (empty with .gitkeep)
  docs/             (corpus copies live here for the team)
```
CI: lint plus test on push, nothing else yet.

## 4. `@andpay/ids` requirements
- Generator: UUIDv7 (RFC 9562 layout: 48-bit unix-ms timestamp, version 7, 74 random bits).
- Public encoding: `<prefix>_<crockford-base32-of-the-128-bits>`, lowercase prefix, Crockford alphabet (no I, L, O, U), fixed 26-character payload, no padding.
- Prefix registry as a typed constant map, one entry per Section 11 registry row. Minimum set to ship now: `mrch_`, `term_`, `asgn_`, `unit_`, `btch_`, `shpt_`, `vndr_`, `api_`, plus the generic codec so any registry prefix is one line to add. Prefixes are IMMUTABLE once a row exists (I4); adding one requires a corpus decision, never a code-only change.
- API: `newId(kind)`, `parseId(kind, s)` (throws on wrong prefix, wrong length, non-Crockford chars), `isId(kind, s)`, `timestampOf(id)` (the accepted UUIDv7 disclosure, Decision 113f), branded TypeScript types per kind (an `AsgnId` is not assignable to a `UnitId`).
- No dependency on any service, database, or framework. Zero runtime deps beyond a UUIDv7 source (implement in-package if trivial).

## 5 to 8. Events, commands, ports, ledger, auth
N/A in this spec. No topics, no outbox, no credentials, no ledger anywhere here (S20 no-money posture is trivially satisfied; there is no money in the entire v1 product).

## 9. Isolation and residency
N/A (library). The repo's docs and CI artifacts carry no PII or secrets (S4).

## 10. Idempotency
N/A (no state mutation). The 06.A key grammar arrives with spec 02 schemas.

## 11. Gate citations
Items 1 (substrate, depends on nothing), 6 (owns nothing), 26 (no telemetry yet; when services arrive they instrument per S21). All money items N/A.

## 12. Acceptance checks (all as vitest tests)
1. Round trip: `parseId(k, newId(k))` succeeds for every registered kind.
2. Sortability: 1,000 sequential `newId` calls produce lexicographically non-decreasing payloads across millisecond boundaries.
3. Rejection: wrong prefix, wrong length, uppercase, and I/L/O/U characters all throw with typed errors.
4. Collision: 100,000 generated ids are unique.
5. `timestampOf` recovers the generation time within 1ms.
6. Type safety: cross-kind assignment fails compilation (type-level test).
7. CI runs lint plus tests green on a clean checkout with `pnpm install && pnpm test`.

## 13. DO-NOT list (repo-wide, goes verbatim into CLAUDE.md)
- Never invent an ID prefix, event topic, or entity; they come only from the architecture corpus by decision.
- No product calls a product; no cross-context DB reads; contexts integrate through facts and rails only (C2, C4, T1, T7).
- No direct ledger writes ever (M4); this product has NO money surface at all (S20).
- merchant_id, vendor scope, and mode come from the authenticated principal, never a request body (M7, S16, 105c).
- Secrets never in code, config files, logs, events, or IDs (S4); redact before the first log line (5c).
- No em-dashes or en-dashes in any document, comment, or commit message; periods or commas.
- When a requirement seems to need something this spec does not grant, STOP and escalate to the architecture chat; do not improvise.

## CLAUDE.md (create at repo root with exactly this scope)
Contents: the one-paragraph platform summary (microservices payments platform, architecture governed by an external corpus, decisions cited by number), the DO-NOT list above, the stack defaults, the instruction that each service directory will carry its own handoff spec as `SPEC.md` and Claude Code implements specs only, and pointers to `docs/` corpus copies.
