# Spec 03 acceptance evidence (event backbone bring-up)

Raw evidence for handoff spec 03, Section 12 acceptance checks. Compiled from the
build run on Bhupender's machine.

## Scope split (agreed)

Claude Code runs no AWS command (CLI or SDK). Checks 1 to 6 are verified against a
REAL Kafka (Redpanda, the local dev stand-in for AWS MSK plus Glue, behind the
swappable ports, C6/Decision 120) and Postgres. Check 7 residency is verified at
the config level via `cdk synth` (region pin, no AWS calls); the live ap-south-1
resource proof is produced by the owner at `cdk deploy`. SPIFFE/mTLS and broker
ACLs are AWS CDK config-as-code applied at deploy (Section 4 deferred instantiation).

Whole-repo gate on completion: lint, typecheck, and 67 tests green (10 test files,
serial because the integration tests share one Postgres and one Kafka).

---

## Check 1: real bus round-trip (E1, E2, E6)

`packages/bus/test/roundtrip.test.ts` PASSED. It exercises, against local Redpanda:

- a row is written to the outbox (payload is the E4 envelope): `outbox.findMany`
  returns 1 row, `publishedAt` is null.
- the real Kafka publisher publishes it: `relayOnce(prisma, new KafkaPublisher(producer))`
  returns >= 1; the row's `published_at` is stamped.
- a test consumer consumes it from Kafka and matches the envelope by `dedup_key`;
  `subject`, `payload`, and `trace_id` are intact end to end.
- inbox dedup: first `onceWithin(...)` returns true, effect runs once, one inbox row.
- re-delivery: a second `onceWithin(...)` on the same dedup key returns false, the
  effect does NOT run again (E6 no double-effect).

---

## Check 2: schema-registry FULL-compat enforcement (Decision 120, E3)

Raw output (register v1, attempt an incompatible change at FULL, then an additive
optional-field change):

```
subject           : acc2.1784488285742-value
compatibility     : FULL
register v1       : id 2
register incompatible: REJECTED, HTTP 409
  raw registry body : {"error_code":409,"message":"Schema being registered is
    incompatible with an earlier schema for subject \"acc2...-value\", details:
    [{errorType:\"TYPE_CHANGED\", description:\"A type at path '#/properties/id'
    is different between the new schema and the old schema\"},
     {errorType:\"TYPE_CHANGED\", description:\"... between the old and the new\"},
     {errorType:\"REQUIRED_ATTRIBUTE_ADDED\", description:\"The keyword at path
    '#/required/status' in the old schema is not present in the new schema\"},
     {oldSchemaVersion: 1}, {compatibility: 'FULL'}]"}
register additive : id 3
```

An incompatible change is a typed rejection carrying the raw registry error, never
a silent send. An additive optional field is accepted (version id 3).

---

## Check 3: envelope round-trip (E4)

`packages/envelope/test/envelope.test.ts`: 11 tests PASSED. All seven E4 fields
(id, type, version, timestamp, subject, dedup_key, trace_id) plus the payload
encode to JSON bytes and decode back intact; `trace_id` is preserved through
encode and decode; malformed envelopes (missing field, bad version, non-parseable
timestamp, missing payload, invalid JSON) are rejected with a typed EnvelopeError.

---

## Check 4: engine step plus compensation, and idempotent step (O3, E1)

Raw output from the reference process manager (two steps, the second fails):

```
===== CHECK 4: step + compensation (O3) =====
saga wire id      : sg_01kxxwmnngetq8g7h2ryfcx4ag
BEFORE instance   : [ { status: 'running' } ]
runFlow result    : compensated
AFTER instance    : [ { status: 'compensated', current_step: 'reserve' } ]
AFTER steps       : [
  { name: 'confirm', status: 'failed',      attempts: 1, last_error_class: 'Error' },
  { name: 'reserve', status: 'compensated', attempts: 1, last_error_class: null }
]
engine outbox     : [
  { event_type: 'cmd.fulfillment.batch.v1',
    payload: { sagaId: 'sg_01kxxwmnngetq8g7h2ryfcx4ag', command: 'reserve_batch' } }
]
reserveRuns       : 1   releaseRuns (compensation): 1

===== CHECK 4: idempotent step (re-delivered fact is a no-op) =====
action runs after 3 runStep calls: 1
step row          : [ { name: 'once', status: 'completed', attempts: 1 } ]
```

The failed second step drives compensation of the first via a forward reversing
action (O3): instance ends `compensated`, `reserve` ends `compensated`, `confirm`
ends `failed`. The command the reserve step emitted is durably in the engine
outbox (E1, committed with the step; compensation is a forward action, not a
rollback). A step re-driven three times runs its action once (idempotent),
attempts stays 1.

Note: the raw capture above predates a follow-up change. The throwaway reference
PM's illustrative command topic was renamed to a test-only name
(`cmd.test.reference_pm.v1`) so it never references the real Fulfillment command
`cmd.fulfillment.batch.v1`. No schema was ever registered for the real command:
the engine has no schema-registry code, the local registry holds only test
subjects, and Glue (production) is not deployed. The real Fulfillment command
schema arrives fresh at step 7, not pre-seeded.

---

## Check 5: durable timer, two genuinely concurrent workers (Decision 77)

Raw output (20 due timers, two workers each capped at 10 via SKIP LOCKED, the
effect holds each transaction open so the workers overlap):

```
worker A window ms: [8, 222]  fired 10
worker B window ms: [1, 222]  fired 10
genuinely overlapped: true
double-fired      : 0
distinct fired    : 20 / 20
timer status      : [ { status: 'fired', n: 20 } ]
```

The overlapping windows prove genuine concurrency (both workers held open
transactions with locked rows at once). FOR UPDATE SKIP LOCKED gives a disjoint
split: no timer double-fired, none skipped, all 20 fired exactly once.

---

## Check 6: config-as-code topic provisioning idempotency (S23)

`packages/bus/test/provision.test.ts` PASSED. First apply creates all defined
topics (`created` equals the full set, `existing` empty). A second apply of the
same definitions creates nothing (`created` empty, `existing` is the full set) and
does not error. Topics are created by the provisioning step, never by a runtime
control-plane call; producers publish only to already-provisioned topics.

---

## Check 7: residency and IDs-only (S6, S7)

Residency is the CDK region pin, validated by `cdk synth` (renders the
CloudFormation locally, no AWS calls, no cost):

```
$ pnpm exec cdk list
EventBackbonePrimary
EventBackboneDr

$ pnpm exec cdk synth EventBackbonePrimary
  Type: AWS::MSK::Cluster        (ClientBroker: TLS, no unauthenticated access)
  Type: AWS::Glue::Registry
  Type: AWS::Glue::Schema        Compatibility: FULL   DataFormat: JSON
  Type: AWS::Glue::Schema        Compatibility: FULL   DataFormat: JSON
  Type: AWS::Glue::Schema        Compatibility: FULL   DataFormat: JSON
  ResidencyRegion:
    Value: ap-south-1
```

The stack throws on any non-India region (residency guard, S6). The live
ap-south-1 proof (`aws kafka list-clusters --region ap-south-1`) is produced by
the owner at `cdk deploy`.

IDs-only payload sample (S7, no PII, no raw PAN/CVV, which do not exist in this
build regardless):

```
{"id":"mrch_01kxx19bscfp9tqd8h5stre55x","status":"active"}
payload keys: id, status (ids and enums only, no PII)
```

---

## Supporting facts

- Orchestrator FORCE RLS (gate item 17 PARTIAL), from `pg_class`:
  `saga_instance | t | t`, `saga_step | t | t`, `saga_timer | t | t`,
  `outbox | t | t`, `inbox | t | t` (relrowsecurity, relforcerowsecurity). Policy
  is permissive for now; per-workload role and Program-scoped predicates deferred
  (no Program-scoped data in this build).
- Cross-schema guard extended to the orchestrator schema; intra-schema FKs
  (saga_step and saga_timer to saga_instance) allowed, cross-schema FKs forbidden.
- `sg_` is a corpus-registered prefix (spec 03 field 3), implemented in
  @andpay/ids with toUuid/fromUuid for I3 native-uuid storage; saga_instance.id
  is stored as a native uuid, the sg_ string is the wire form.

## Interpretive choices to ratify

1. Envelope-as-outbox-payload: the outbox `payload` column holds the full E4
   envelope; the relay routes by the row's event_type and partition_key. No outbox
   schema change (spec 02 unchanged).
2. sg_ prefix plus toUuid/fromUuid added to @andpay/ids (corpus-registered prefix,
   I3 storage helpers reusable by every service).
3. FORCE RLS recorded now with a permissive policy; per-workload least-privilege
   role and Program-scoped predicates deferred to the domain-table specs.
4. The engine is content-agnostic: the reference PM (test-only) emits an
   illustrative command showing E1; production flows wrap commands in the E4
   envelope so they publish through the same KafkaPublisher path as facts.
5. Local Redpanda is the dev stand-in for MSK plus Glue behind the swappable
   ports; MSK/Glue/ap-south-1 and SPIFFE/mTLS/ACLs are CDK config-as-code applied
   at deploy.

## Commits

- 000fda4 @andpay/envelope plus local Redpanda substrate
- e7b8e39 @andpay/bus (Kafka publisher, schema registry, topic provisioning)
- c774c2a D77 engine, orchestrator schema, sg_ id; CI for the full stack
- fca4778 AWS CDK for MSK plus Glue (ap-south-1); spec 03 build ledger
- df740c4 engine timer test hardening (deterministic split)
- bab9992 infra/aws switched from npm to standalone pnpm; cdk synth validated

## Status

Spec 03 is BUILT with evidence, awaiting plan-chat ratification to flip the Event
backbone, @andpay/envelope, and the orchestration-engine rows to BUILT-V1. Real
MSK/Glue deploy is deferred to first deployment. On ratification, the D118
sequence continues at step 5 (Identity-min).
