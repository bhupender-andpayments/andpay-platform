# Handoff Spec 06: TMS-thin (bank-file ingest, the assignment aggregate, QR/VPA custody, damage/replacement, the device-port seam)

Claude Code implements this spec and never invents architecture (Decision 114). Governing corpus: Decisions 63, 102, 115, 116, 117; rule S20 (the Fulfillment rail it hands demand to), C1, C2, C4, C5, O1, O2, T1, T2, T3, T7, T11, T12, I5, K3, S6, S7, S8, S21, S23; the D120 wire-contract discipline; chapter 06.A idempotency grammar. Sequence step 6, TMS-thin (ingest plus assignment). It moves NO money. One spec, verified by raw evidence before any build-state flip.

## 0. Forks resolved before authoring (ratified this session, validated against the docs)

* Fork A, the ingest-to-assignment flow and the row-fact contract (now real and bidirectional). TMS owns the bank request-file ingest channel (D116, S8-untrusted). It emits `fct.tms.bank_file_row.v1`, and this fact binds VERBATIM to the contract Identity-min already defined at step 5 (`services/identity/src/row-fact.ts`): the merchant slice, tenant slice, Program slice, the vpa hint, and the `{file_id}|{row_no}` correlation id, and NOTHING else. The demand slice, the QR/VPA value, and the ship-to stay in TMS's own store, off the shared fact (S7/S5). Identity consumes the row fact, upserts, and emits its merchant and enrollment facts (the enrollment fact carries the correlation id plus the resolved `mrch_`, `prog_`, `tnnt_`). TMS joins on the correlation id and creates the `asgn_`.
* Fork B, the assignment lifecycle and the demand handoff. TMS demand states are the corpus set (intake section 74): received, pooled-for-fulfillment, closed, replacement-raised, plus ACTIVATED. TMS emits the demand-assignment fact `fct.tms.assignment.v1` that Fulfillment consumes (S20, C5, O1); TMS never holds a Fulfillment-side state (QR-generated, sent-to-vendor, dispatched-by-vendor, shipment/courier), that split is T2/T12. `pooled-for-fulfillment` is TMS's own state meaning demand released into the fulfillment pipeline (the demand fact emitted); the batch-level pooling and trigger are Fulfillment's separate facts. At step 6 the demand fact has no live consumer (Fulfillment is step 7), so it is fixture-verified.
* Fork C, the device port and activation scope. Step 6 builds the TMS device-port INTERFACE and the activation-command and activation-fact contract (`fct.tms.assignment.activated`), fixture-exercised. Deferred behind the port: the CWD partner-mediated activation API adapter (external-dependency-bound) and the direct-broker AWS IoT Core family; the activation-report projection (needs the delivered state Fulfillment produces at step 7); and the active device-to-merchant binding aggregate (`term_` is registered to Terminal/Device Mgmt but the full terminal record is the terminal-management product proper, so v1 records activation as a fact against the `asgn_` and defers the binding aggregate). Device identity and activation facts are identical across adapter families (C6/T11 applied to devices).
* Fork D, ship-to (the intake's one open question, answered). Ship-to is a per-assignment SNAPSHOT and a dispatch instruction (D116), resolved from the file address, with a per-bank deliver-to policy (merchant-premises or bank-HO) as Program config defaulting to the file address. It is amendable until the assignment is pulled into a triggered batch, after which a destination change is a superseding re-instruction fact, never a silent edit (D116). The AWB grain (per-kit versus per-consignment) is a Fulfillment shipment concern (`shpt_`, step 7), so TMS carries only the ship-to snapshot. The post-batch amendment lock is gated on a Fulfillment batch-triggered fact (step 7), so at step 6 the amend operation is built and the lock is fixture-deferred.

## 1. Identity

TMS-thin is the Terminal Management context built to the minimal demand-side slice the soundbox needs (D63, D102 ownership locked; aggregate and intake per D116). It owns the bank request-file ingest, the `asgn_` assignment aggregate (the BRD Dispatch ID), QR/VPA value custody (D102/D117), the operator flag-damage replacement workflow (D-26; the damage-file ingest is deleted, D-25), and activation orchestration through the TMS device port. It depends downward only and calls no product (C1, C2); it emits facts and Fulfillment consumes them, TMS never calls Fulfillment (C5, O1). It references merchant_id and holds no identity or KYC (I1, K2, K3). It holds NO money (no ledger, no M4, no S9).

## 2. Owned data

The `tms` schema on the one-instance schema-per-context topology (spec 02), plus the mandatory `outbox` (E1) and `inbox` (E6). FORCE RLS with a per-workload least-privilege role (S13). Table classes per chapter 07.A.

* `assignment` (Program-scoped, 07.A class 1): `asgn_` id (typed prefix, native `uuid` per I3; externally the BRD Dispatch ID), `mrch_` id and `prog_` id and `tnnt_` id (resolved from Identity, references not attributes), merchant_snapshot (display_name, legal_name, mcc, the event-carried copy of the canonical merchant at creation), bank_snapshot (bank_reference_code, display_name), ship_to_snapshot (address fields), qr_value, vpa_value, soundbox (bool), standee_count, sticker_count, billable (bool, false for a replacement), replacement_of (`asgn_` ref, nullable), damage_reason (nullable, from the configurable master), bank_remarks (nullable), case_status (nullable, Open/In-Progress/Closed for a replacement), demand_state (received/pooled-for-fulfillment/closed/replacement-raised), activated_at (nullable), created_at, updated_at. RLS predicate on `program_id`. NO Fulfillment-side status column (T2, T12).
* `pending_row` (TMS-internal ingest staging, not a fact): surrogate `uuid` pk, correlation id `{file_id}|{row_no}` UNIQUE, tenant_reference, the parsed demand and QR/VPA and ship-to slice, status (awaiting-identity/consumed), created_at. Holds the row while the assignment awaits the Identity enrollment fact. Permissive read in v1.
* `merchant_projection` (TMS read-model from `fct.identity.merchant.v1`, T7): `mrch_` id pk, display_name, legal_name, mcc, status, updated_at. The source of the assignment's merchant snapshot. Event-carried, never a read of Identity's DB (C4).
* `tenant_projection` (TMS read-model from `fct.identity.tenant.v1`, T7): `tnnt_` id pk, display_name, bank_reference_code. The source of the assignment's bank snapshot.
* `ingest_file` (Program/tenant-scoped): file_id pk, source (bank_request/bank_damage), tenant_reference, row_total, row_accepted, row_rejected, status, created_at. The S8 ingest record.
* `quarantine_row` (Program/tenant-scoped): surrogate `uuid` pk, file_id, row_no, raw_row (redacted for log), reason_code, created_at. Rejected or discrepant rows (S8 row-level rejection, never an auto-create).
* `outbox` (E1), `inbox` (E6): the `@andpay/outbox` tables, unchanged from spec 02.

RATIFIED (this session): the section 2 vs section 9 conflict on ingest-table RLS is resolved as follows. Only `assignment` is Program-scoped with a `program_id` write-gate. `pending_row`, `merchant_projection`, `tenant_projection`, `ingest_file`, and `quarantine_row` get FORCE RLS with permissive policies in v1, because they are written at ingest before Identity resolves the Program (a file can span Programs; rejected rows never resolve). Real tenant scoping is deferred to step 9.

## 3. IDs minted

`asgn_` (registered to TMS in the Section 11 registry per D115, minted in-process via `@andpay/ids`, D119 codec). No `term_` is minted in v1 (the active binding aggregate is deferred, Fork C). `pending_row`, `merchant_projection`, `tenant_projection`, and `quarantine_row` use surrogate keys, not registry prefixes (I3/I4, spec-04 precedent). No new prefix is introduced.

## 4. Events

* Produced (JSON on Glue at FULL compat, E4 envelope, D120):
   * `fct.tms.bank_file_row.v1`, partition key a stable per-(tenant, bank_merchant_reference) key so all rows for one prospective merchant are ordered (avoids a create/update race in Identity). Fields: the identity slice, tenant slice, Program slice, vpa hint, and the `{file_id}|{row_no}` correlation id, binding VERBATIM to the step-5 `services/identity/src/row-fact.ts` contract. No demand slice, no QR/VPA value, no ship-to (S7/S5).
   * `fct.tms.assignment.v1` (the demand-assignment fact S20/Fulfillment consumes), partition key `asgn_` id. Fields: `asgn_` id, `mrch_`/`prog_`/`tnnt_` ids, merchant_snapshot, bank_snapshot, ship_to_snapshot, qr_value, vpa_value, demand (soundbox, standee_count, sticker_count), billable, demand_state, and the source-row correlation id. This is the event-carried snapshot that keeps every dashboard a local projection with no C4 read (D116).
   * `fct.tms.assignment.ship_to_amended.v1`, partition key `asgn_` id: the superseding re-instruction (Fork D, D116).
   * `fct.tms.assignment.replacement_raised.v1`, partition key `asgn_` id: a replacement referencing the original.
   * `fct.tms.assignment.activated.v1`, partition key `asgn_` id: the TMS ACTIVATED fact (D63, activation is a TMS fact).
* Consumed:
   * `fct.identity.enrollment.v1`: carries the correlation id plus `mrch_`/`prog_`/`tnnt_`; the trigger to join the pending row and create the `asgn_`. Inbox dedup on the enrollment fact's event id (E6).
   * `fct.identity.merchant.v1`: projected into `merchant_projection` for the snapshot.
   * `fct.identity.tenant.v1`: projected into `tenant_projection` for the bank snapshot.
   * The bank-file (request and damage) itself, an S8-untrusted file the ingest adapter parses; at step 6 it is fixture-fed (the class-3 ops upload surface is step 9).

RATIFIED (this session): the assignment lands in `pooled-for-fulfillment` with the demand fact emitted atomically on creation (one step); a damage replacement emits BOTH `fct.tms.assignment.replacement_raised.v1` and `fct.tms.assignment.v1` (billable=false), and the original moves to `replacement-raised`.

## 5. Commands

No saga in v1. The ingest-to-assignment join is inbox-driven (on the enrollment fact), not a D77 process manager (the batching PM is Fulfillment at step 7). Ship-to amend and the manual operations are class-3 ops actions wired at the portal (step 9); at step 6 they are invoked directly or by fixture. No `cmd.*` topic is introduced by TMS-thin in v1.

## 6. Ports and adapters

* The bank-file ingest adapter (S8-untrusted parse, row-level validation, rejection report, quarantine, 06.A file-plus-row idempotency). TMS-owned channel (D116); fixture-fed at step 6, the class-3 ops upload surface at step 9.
* The TMS DEVICE PORT (Fork C): an interface with the activation-command and activation-fact contract, two adapter families (partner-mediated CWD, direct-broker AWS IoT), identical device identity and activation facts across families (C6/T11). Both adapters deferred (external-dependency-bound); the interface and fact contract are built now.
* No Processor Port, no Issuing, no Settlement, no money adapter (no money in this product).

## 7. Ledger interaction

NO LEDGER, NO MONEY (D116, intake section 7: no money moves anywhere in this product). TMS-thin holds no posting capability (5f/M11). The billable flag is a demand attribute for later billing, never a v1 ledger posting. Idempotency is the 06.A file-plus-row key, not an M7 posting floor.

## 8. Auth surface

TMS-thin serves no principal directly in v1 (no HTTP shell; portals wire HTTP at step 9). The ingest is a class-3 ops action (the bank emails files, ops uploads them), fixture-invoked at step 6, the class-3 auth from spec 04 wired at step 9. The consume-project-join-emit runs as an internal workload authorized at the bus by its SVID (S11, S12). No new audience, no class-6 principal here (the class-6 vendor is Fulfillment's), no step-up catalog entry.

## 9. Isolation and residency

`program_id` RLS predicate on `assignment` (07.A class 1), write-gated `WITH CHECK (program_id = current_setting('app.program_id', true)::uuid)` with `SET LOCAL app.program_id` before every Program-scoped write (07.B); reads open in v1. `pending_row`, `merchant_projection`, `tenant_projection`, `ingest_file`, and `quarantine_row` are FORCE RLS permissive in v1 (ratified), the tenant-portal predicate deferred to step 9. FORCE RLS on all tables under the staged per-workload role (the spec-02/03/04 DB-boundary precedent). All stores India-resident (S6), static now (cdk synth), live proof at deploy. PII (S7): the merchant snapshot (names), the ship-to, and the QR/VPA value are carried on the assignment fact by design (D116/D117 event-carried), minimized, and are redacted from every log line (S7, S4). The E4 `trace_id` propagates from the consumed row and enrollment facts through the join to every emitted assignment fact (S21).

## 10. Idempotency

* Ingest is idempotent on the 06.A file-plus-row key: re-ingesting the same `{file_id}` is a file-level no-op; each `{file_id}|{row_no}` produces at most one `fct.tms.bank_file_row.v1` and one `pending_row`.
* Assignment creation is idempotent on the correlation id: a redelivered `fct.identity.enrollment.v1` for the same correlation id creates no second `asgn_` (inbox dedup plus the `source_event_id` UNIQUE and the `pending_row` status guard).
* A damage row is idempotent on its own `{file_id}|{row_no}`: one replacement `asgn_` per damage row.
* Ship-to amend is idempotent on (asgn_, amendment sequence); a redelivered amend is a no-op.

## 11. Gate citations

* Item 6 (each context owns its own data): TMS-thin owns the `tms` schema; it projects Identity facts and performs NO cross-context DB read (C4, T7).
* Status ownership: TMS owns demand states and ACTIVATED, Fulfillment owns the middle (T2, T12); products emit facts, Fulfillment consumes, TMS never calls it (C5, O1).
* QR/VPA: value custody with transmit-never-mint downstream (D102, D117, T2).
* Item 17 partial (isolation): FORCE RLS, `program_id` predicate on the Program-scoped table (assignment); the tenant-portal read predicate deferred to step 9.
* Item 28 (S23): expand-contract, reversible migrations; the initial `tms` domain migration is additive.
* Money items: N/A (no ledger, no M4).

## 12. Acceptance checks (each by RAW evidence, not a green summary)

The bank file is fixture-fed at step 6; the demand fact's Fulfillment consumer arrives at step 7. Load-bearing items to show in raw mechanism form: checks 1, 2, and 3.

1. (LOAD-BEARING) Ingest-to-assignment round trip, the row fact binds to step 5. A fixture bank-file row is validated (S8), emits `fct.tms.bank_file_row.v1`, and that payload VALIDATES against the step-5 `services/identity/src/row-fact.ts` contract with no schema drift; the real Identity consumer (step 5) upserts and emits the enrollment and merchant facts; TMS joins on the correlation id and creates exactly one `asgn_` carrying the merchant snapshot (from `merchant_projection`, sourced from `fct.identity.merchant.v1`), the bank snapshot, the ship-to (from the row), and the QR/VPA value. Raw: the row-fact payload, the schema-validation result, the assignment row, the correlation join.
2. (LOAD-BEARING) Snapshot provenance and no C4 read. The assignment's merchant snapshot comes from `merchant_projection` fed by `fct.identity.merchant.v1`, never a read of Identity's DB; the cross-schema architecture guard forbids any `services/identity` import, and the assignment is created with no Identity DB handle. Raw: the guard (planted-import fails, removed passes) and the projection source.
3. (LOAD-BEARING) Idempotency, 06.A file-plus-row. Re-ingesting the same `{file_id}|{row_no}` is a no-op (no second row fact, no second `pending_row`); a redelivered `fct.identity.enrollment.v1` for the same correlation id creates no second `asgn_`. Raw counts before and after.
4. QR/VPA custody and handoff (D117). The QR/VPA value is on `fct.tms.assignment.v1` (for Fulfillment) and is NOT on `fct.tms.bank_file_row.v1` (Identity does not need it, S7/S5); v1 validates FORMAT only and never mints, derives, or alters the value (T2). Raw: the two fact payloads.
5. Demand-state ownership (T2, T12). Raw `\d assignment` showing only TMS demand states and `activated_at`, and NO Fulfillment-side status column (QR-generated, sent-to-vendor, dispatched-by-vendor, shipment).
6. Damage and replacement (D116, reshaped by D-25/D-26). An operator flags a damaged dispatch leg (`flagDamageOps`), which creates a NEW `asgn_` with `replacement_of` set, `billable=false`, `damage_reason` holding the ACTIVE master code, `ops_remarks` holding the operator's note, `flagged_by` naming the operator, `case_status=Open`, all on the replacement (no separate case aggregate). The damage-file ingest that used to feed this is deleted; historical file-born replacements remain readable. Raw: the replacement row and its reference.
7. Ship-to snapshot and amend (D116, Fork D). Ship-to is a per-assignment snapshot from the row (per-bank deliver-to policy defaulting to the file address); an amend before batch-trigger updates it and emits `fct.tms.assignment.ship_to_amended.v1`; the post-batch lock is gated on a Fulfillment batch-triggered fact (fixture at step 6). Raw: the snapshot and the amend fact.
8. Device-port seam (Fork C). The device port is an interface with the activation-command and activation-fact contract; the CWD adapter, the AWS IoT family, and the activation-report projection are deferred; a fixture activation emits `fct.tms.assignment.activated.v1` and sets `activated_at`. Raw: the port interface and the fixture activation fact.
9. Residency, PII redaction, trace_id (S6, S7, S21). `tms` stores pinned India-resident (cdk synth, deploy-deferred live proof); merchant names, ship-to, and the QR/VPA value redacted before the first log line; the `trace_id` on the consumed facts appears on every emitted assignment fact. Raw: the redacted log line, the static residency test, the trace_id set.
10. E1 atomicity. The assignment write and the `fct.tms.assignment.v1` enqueue commit or roll back together (0 rows after a rolled-back operation, present after commit), reusing `@andpay/outbox`. Raw.

## 13. DO-NOT list

* No product calls a product (C1, C2, C5, O1); TMS emits facts, Fulfillment consumes, TMS never calls Fulfillment or Identity.
* No cross-context DB read (C4, T7); TMS projects Identity facts into its own read-models, never reads Identity's tables.
* TMS never mints, derives, or alters the QR/VPA value; it carries the bank-supplied value and validates FORMAT only (T2, D102, D117).
* No Fulfillment-side status on the assignment (T2, T12); the Received-to-Activated chain is a projection, never one status column.
* Device-to-bank/tenant is never a device attribute; it is derived device to merchant to Program to tenant (I5, T3).
* No separate damage case aggregate in v1; case status lives on the replacement assignment (D116).
* No new prefix without a decision; `asgn_` is registered, `term_` and the active binding aggregate are deferred, and the internal tables use surrogate keys (I3, I4).
* Ship-to is never silently edited after package composition; a destination change is a superseding re-instruction fact (D116).
* The row fact carries only the identity slice, tenant slice, Program slice, vpa hint, and correlation id; no QR/VPA value, no demand slice, no ship-to (S7, S5), and it must not drift from the step-5 `services/identity/src/row-fact.ts` contract.
* No KYC (K3, bank-held via Identity); no money, no ledger, no M4 (5f, M11).
* No runtime control plane; the damage-reason master, the per-bank deliver-to policy, and validation config are config-as-code, CODEOWNERS-gated (S23).
* No em-dashes in any document, comment, or commit message.

## Verification cadence

Claude Code runs on Bhupender's machine; this chat cannot see the repo. On completion, paste RAW output for the ten acceptance checks (a green summary is a claim, not evidence). Load-bearing in raw mechanism form: the ingest-to-assignment round trip with the row fact binding to the step-5 contract (check 1), snapshot provenance and no C4 read (check 2), and 06.A file-plus-row idempotency (check 3). On consistent evidence, the USER flips the TMS row to BUILT-V1 (scoped to the v1 thin slice) in `docs/platform_build_state.md` with a milestone line; then the D118 sequence continues at step 7 (Fulfillment). Registered deferrals: the class-3 ops upload surface (step 9); the CWD activation API adapter and the AWS IoT Core direct-broker family (external-dependency-bound, behind the device port); the activation-report projection (needs the delivered state, step 7 or the step-10 dashboards); the active device-to-merchant binding aggregate (`term_`, deferred with activation); the per-bank deliver-to default policy and the AWB grain (Fulfillment, step 7); the post-batch ship-to amendment lock (gated on the Fulfillment batch-triggered fact, step 7); the real Fulfillment consumer of the demand fact (step 7, fixture-verified now); the live ap-south-1/2 residency proof (deploy); the tenant-portal RLS read predicate (step 9).
