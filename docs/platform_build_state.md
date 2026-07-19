# Platform Build State (repo side ledger)

> Repo side mirror of the platform build state. The AUTHORITATIVE build state
> lives in the architecture corpus (the plan chat) alongside architure_context.md
> and the chapter files. This file is updated as handoff specs land in this
> repository, and should be reconciled with the corpus copy. It records WHAT has
> been built here and its verification, never new architecture.

## Legend
- DONE: implemented, all acceptance checks green.
- IN PROGRESS: spec received, implementation underway.
- PENDING: expected next, spec not yet received.

## Specs

### Spec 01: Platform Bootstrap (monorepo skeleton plus @andpay/ids)
- Status: DONE
- Landed: 2026-07-19
- Layer: substrate. Decision 118, build step 1.
- Source: docs/handoff_spec_01_platform_bootstrap.md
- Bootstrap commit: 67f3e0a

Delivered:
- Monorepo skeleton per spec Section 3 (pnpm workspaces, TypeScript strict,
  vitest, CI running lint plus test on Node 22).
- Placeholders: services/{identity,tms,fulfillment}, apps/{ops-portal,
  vendor-portal}, infra/ (each with .gitkeep).
- Root CLAUDE.md (platform summary, DO-NOT list, stack defaults, SPEC.md rule,
  docs pointers).
- docs/ corpus copies: architecture_rules.md, the spec, and this ledger.
- packages/ids (@andpay/ids): UUIDv7 (RFC 9562) plus lowercase Crockford Base32,
  26 char payload, monotonic k sortable, branded per kind types, typed
  validation, zero runtime deps.

Acceptance checks (spec Section 12): 7 of 7 green.
1. Round trip per kind: pass.
2. Sortability across 1000 sequential ids: pass.
3. Typed rejection (wrong prefix, wrong length, uppercase, I/L/O/U): pass.
4. Collision, 100,000 unique: pass.
5. timestampOf within 1ms (observed 0ms): pass.
6. Cross kind assignment fails compilation: pass.
7. CI green on clean checkout (pnpm install plus pnpm test), plus lint and
   frozen lockfile parity: pass.

Gate citations (spec Section 11): item 1 (substrate, depends on nothing),
item 6 (owns nothing), item 26 (no telemetry yet). All money items N/A (S20).
Identity invariants honored: I2, I3, I4.

ID registry rows shipped: mrch, term, asgn, unit, btch, shpt, vndr, api.
Codec is prefix agnostic; a new registry row is one line to add and requires a
corpus decision (I4).

Open items for the plan chat to ratify (see the returned status):
- Monotonic in millisecond generation semantics.
- The exact canonical codec (MSB first, 26 lowercase Crockford chars, two
  leading zero pad bits, no padding characters) as a cross service contract.
- Kind identifiers as prefix stems, newId(kind) returning the branded type.
- ESLint plus typescript-eslint as the lint tool (Section 4 swappable default).

### Spec 02: Per-context schemas, outbox/inbox, and the 06.A key grammar
- Status: BUILT, evidence provided 2026-07-19; awaiting plan-chat ratification to
  BUILT-V1. The four load-bearing artifacts (atomicity, cross-schema guard teeth,
  migration reality via psql, relay concurrency) were pasted for review; the
  authoritative build-state flip is the plan chat's to make.
- Landed: 2026-07-19
- Layer: substrate. Decision 118, build step 2.
- Source: handoff spec 02 plus chapter 06.A (docs/06_settlement_refund_issuing.md).

Delivered:
- One postgres:16 instance, one schema per context (identity, tms, fulfillment),
  one Prisma client per context pinned to its own schema via ?schema=. No
  cross-schema query, no cross-schema FK. Initial migrations create each schema
  with the outbox and inbox tables only (no domain tables).
- @andpay/outbox (BUILT-V1): enqueue (E1, atomic with the caller's transaction),
  onceWithin (E6 consumer inbox, effectively-once, no money floor S20), relayOnce
  (FOR UPDATE SKIP LOCKED, at-least-once), and a swappable PublisherPort with
  in-memory and log implementations. The real MSK relay is spec 03; the Event
  backbone row stays DESIGNED.
- @andpay/keys (BUILT-V1): the canonical 06.A grammar, reconciled with the
  chapter (see spec 01 ledger entry updated at commit for keys).
- infra/docker-compose.dev.yml, infra/db.sh, and CI wired to a postgres:16
  service running migrate deploy, lint, typecheck, and test.

Acceptance checks (spec 02 Section 12): 8 of 8 green.
1. enqueue in a rolled-back transaction leaves no outbox row: pass.
2. enqueue outside a transaction throws: pass.
3. relay publishes each unpublished row once; a re-run publishes nothing: pass.
4. onceWithin runs the effect once and skips duplicates, including concurrent
   callers: pass.
5. key grammar: two-attempts-different-keys, raw pipe rejected, client key never
   below the instance key: pass.
6. cross-schema guard: pass. The static guard (test/architecture.test.ts) forbids
   (A) a context migration declaring any FK,
   (B) a prisma schema going multi-schema or losing its per-context url pin,
   (C) a context file naming another context's schema by qualified identifier,
   (E) a context file mutating search_path (the bare-name evasion of C),
   (F) a context file connecting via another context's url or ?schema=, and
   (D) a context importing another context's generated client or source. Teeth
   verified: a planted Fulfillment file with a qualified "tms"."outbox" query, a
   SET search_path TO tms, and a TMS_DATABASE_URL each fail checks C, E, and F
   respectively. The guard is a static net, not a proof; the definitive C4
   enforcement is per-context pinned clients now and per-context DB roles with
   schema-scoped USAGE when S13 lands with the domain tables.
7. migrate deploy on a clean Postgres creates each schema with outbox and inbox,
   no cross-schema FK, re-run is a no-op: pass (verified end to end).
8. no PII column in any table created here; no secret or PII in any fixture: pass.

Isolation note (spec 9): the infrastructure tables carry no tenant-visible rows,
so RLS is not yet applicable. RLS and program_id scoping are a DEFERRED item for
the domain-table specs, recorded here, not silently skipped.

Milestone: spec 02 done. Per-context schemas plus outbox/inbox plus the 06.A key
library in place; the one-instance schema-per-context topology is realized.

### Spec 03 and beyond: MSK bus, relay adapter, orchestration engine
- Status: PENDING
- Notes: spec 03 brings the MSK bus, the real relay adapter behind the
  PublisherPort seam, and the D77 orchestration engine. Not yet received.

## Environment baseline (local)
- Node local: 24.x (CI pinned to Node 22 per spec).
- pnpm: 10.30.3 (packageManager pinned in root package.json).
