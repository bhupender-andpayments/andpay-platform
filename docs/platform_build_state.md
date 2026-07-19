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

### Spec 02: Schemas and the 06.A idempotency key grammar
- Status: PENDING
- Notes: arrives per spec 02 (spec 01 Sections 10 and 12 reference it). Not yet
  received.

## Environment baseline (local)
- Node local: 24.x (CI pinned to Node 22 per spec).
- pnpm: 10.30.3 (packageManager pinned in root package.json).
