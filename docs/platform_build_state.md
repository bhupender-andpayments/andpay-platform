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

### Spec 03: Event backbone bring-up (envelope, publisher, registry, D77 engine)
- Status: BUILT, evidence provided 2026-07-20; awaiting plan-chat ratification to
  flip the Event backbone, @andpay/envelope, and orchestration-engine rows to
  BUILT-V1. The authoritative flip is the plan chat's to make.
- Landed: 2026-07-20
- Layer: substrate. Decision 118 build step, Decisions 77, 119, 120.
- Source: handoff spec 03 plus architecture_rules E1-E9, O1-O5, S6, S7, S11-S12, S23.

Scope split (this machine has no AWS; Claude Code runs no AWS command):
- Verified locally against a real Kafka (Redpanda, the dev stand-in for MSK plus
  Glue behind the swappable ports) and Postgres: checks 1 to 6.
- AWS MSK, Glue, ap-south-1 residency, and SPIFFE/mTLS plus broker ACLs are AWS
  CDK config-as-code under infra/aws, applied by the owner; check 7 residency is
  the CDK region pin (owner deploys and verifies).

Delivered:
- @andpay/envelope (BUILT-V1 candidate): the E4 codec, JSON on the wire (D120).
- @andpay/bus: the Kafka/MSK publisher behind the spec-02 PublisherPort (C6), the
  schema-registry port (Redpanda dev adapter, Glue prod via CDK, D120), config-
  as-code topic provisioning, and a fact-consumer helper.
- @andpay/engine (BUILT-V1 candidate): the D77 step/compensation/timer layer,
  isolated (O4), client-agnostic.
- services/orchestrator: the orchestrator schema (saga_instance, saga_step,
  saga_timer, outbox, inbox), intra-schema FKs, FORCE RLS on every table (gate 17
  recorded; permissive policy, per-workload role and Program predicates deferred,
  no Program-scoped data in this build).
- @andpay/ids: sg_ prefix (corpus-registered) plus toUuid/fromUuid (I3 storage).
- infra: Redpanda added to the dev compose; infra/aws CDK for MSK plus Glue in
  ap-south-1/ap-south-2 with a residency guard; CI runs the full local stack.

Acceptance checks (spec 03 Section 12):
1. real bus round-trip (outbox to Kafka to inbox-deduped consumer, re-delivery a
   no-op, trace_id propagated): GREEN (local Redpanda).
2. schema-registry FULL-compat enforcement (incompatible rejected with the raw
   registry error, additive accepted): GREEN (local Redpanda registry).
3. envelope round-trip of all seven E4 fields plus payload: GREEN.
4. engine step plus compensation (O3) and idempotent re-delivered step: GREEN.
5. durable timer, two concurrent workers, no double-fire and no skip: GREEN.
6. config-as-code topic provisioning idempotent on re-apply: GREEN.
7. residency (MSK/Glue in ap-south-1) plus IDs-only payload: IDs-only shown
   locally; ap-south-1 is the CDK region pin (infra/aws), owner deploys and
   verifies (Claude Code runs no AWS command).

Event backbone row: the internal MSK bus is BUILT against the local stand-in with
the MSK swap as config-as-code; the real MSK/Glue deploy and its residency
evidence are the owner's. Milestone on ratification: spec 03 done, the event
backbone (envelope, publisher, schema registry, topic taxonomy) and the D77
engine scaffolding in place; D118 sequence continues at step 5 (Identity-min).

## Environment baseline (local)
- Node local: 24.x (CI pinned to Node 22 per spec).
- pnpm: 10.30.3 (packageManager pinned in root package.json).
