# Handoff Spec 05: Identity-min (bank-sponsored merchant, tenant, Program, enrollment)

Claude Code implements this spec and never invents architecture (Decision 114). Governing corpus: `architure_context.md` Section 6 (identity model), Section 11 (prefix registry), Decisions 115 to 117 (soundbox intake) and the D116 demand-side ownership lock; `architecture_rules.md` I1 to I5, K2 to K4, C1, C2, C4, T1, T2, T3, T7, S6, S7, S23, and the D120 wire-contract discipline. This is a CHANGE spec, the Identity Registry minimal slice for the soundbox build, sequence step 5. It moves NO money. One spec, verified by raw evidence before any build-state flip.

## 0. Forks resolved before authoring (ratified this session)

* Fork A, bank-file ingest split and the merchant-before-assignment ordering. TMS-thin owns the bank request-file ingest channel (D116) and emits a normalized per-row ingest fact after S8 validation. Identity-min CONSUMES that fact, upserts the merchant, tenant, Program, and enrollment, and emits `fct.identity.*`. TMS-thin's assignment creation (step 6) consumes `fct.identity.merchant.v1` to resolve and snapshot the merchant. Identity does no file parsing and holds no file adapter. Sequencing wrinkle handled: Identity-min (step 5) is built before TMS-thin (step 6), so the consumed row fact is driven by a TEST FIXTURE at step 5 and wired to the real TMS producer at step 6 (the spec-04 stubbed-seam precedent).
* Fork B, the mrch_ resolution and dedup key (RESOLVED, ratified this session). I1's canonical PAN/GSTIN dedup is NOT AVAILABLE in the bank-sponsored path because KYC is bank-held (K3), so the bank file carries no PAN/GSTIN. A bank-file row is resolved to a merchant by (tenant_id, bank_merchant_reference), NOT by (program_id, ...): the bank's own merchant reference is stable across that bank's Programs (D116, a dedup hint within a bank), so the same merchant under a new Program reuses the existing mrch_ and only a first-seen (tenant, reference) mints a new one. VPA is a secondary dedup hint only, never the identity key (D116, I1). This is DB-ENFORCED by a dedicated Identity-owned resolver table merchant_bank_ref with UNIQUE(tenant_id, bank_merchant_reference), fail-closed, NOT application logic over a non-unique index (a boundary, not a lint). I5 stays clean: the tenant-scoped reference lives in the xref mapping, never as a merchant column and never as resolution duty on the Program-scoped enrollment, so the merchant is merchant-global and bank-agnostic. mrch_ uniqueness is per-(tenant, reference) in v1; cross-bank merge is not attempted and PAN/GSTIN dedup is reintroduced for direct Programs (where we own KYC) without a retrofit, the resolver gaining a KYC-keyed path.
* Fork C, the fct.identity.merchant.v1 schema and the Auth fact-read seam. Identity-min publishes the identity facts for TMS-thin and the dashboards. The Auth-side fact-read consumer that spec 04 stubbed stays STUBBED, not built, because v1 authenticates only class-3 (config-resolved) and class-6 (credential-binding-resolved) principals, neither of which reads merchant identity; the Auth consumer lands with the first class-1/2/4 product. This corrects the spec-04 milestone phrasing "wired at Identity-min": Identity emits the fact now, the Auth projection has nothing to resolve in v1.
* Prefixes (registry-confirmed, no decision needed). `mrch_` (Identity Registry), `tnnt_` (Tenant, Platform/Identity), `prog_` (Program, Platform/Identity) are registered and Identity's to mint. The sponsor bank is a `tnnt_` tenant (I5, "a bank is a counterparty plus a portal access-tenant"), NOT `bank_` (Counterparty Directory's namespace, not built in the soundbox; minting it would violate D116's no-foreign-namespace rejection). The enrollment uses a surrogate uuid keyed by (mrch_, prog_), no invented `enrl_` prefix (I3/I4, spec-04 surrogate-key precedent).

## 1. Identity

Identity-min is the Identity Registry context built to the minimal slice the soundbox needs: the canonical bank-sponsored merchant (`mrch_`), the sponsor bank as a tenant (`tnnt_`), the Program (`prog_`), and the merchant-in-Program enrollment, all upserted from the TMS-thin bank-file ingest fact, publishing `fct.identity.*` for TMS-thin and the dashboards. Section 5 layer: Rail A (Identity and Trust), cross-cutting, referenced by every layer, calls no product (C1, C2). It holds NO KYC (bank-held, K3) and no money. Auth owns no merchant identity (C1, S10, D121); Identity-min owns it.

## 2. Owned data

The `identity` schema on the one-instance schema-per-context topology (spec 02), plus the mandatory `outbox` (E1) and `inbox` (E6). FORCE RLS with a per-workload least-privilege role (S13). Table classes per chapter 07.A.

* `merchant` (merchant-global relationship-gated, 07.A class 2): `mrch_` id (typed prefix, stored as native `uuid` per I3), display_name, legal_name, mcc, registered_address (reference identity, minimized per S7), activation_state, status (ACTIVE/SUSPENDED, a status not a delete), created_at, updated_at. NO tenant_id, NO bank_id, NO program_id, NO bank_merchant_reference column (I5, T3: neither sponsorship nor a bank-scoped reference is ever a merchant attribute). NO KYC, NO PAN, NO GSTIN (K3, bank-held). RLS: permissive read in v1 (write-gated); the tenant-portal relationship-gated predicate is deferred to the class-2 read surface (step 9), a per-workload role suffices in v1 (the spec-03/04 partial-RLS staging).
* `merchant_bank_ref` (Identity-owned resolver/xref, tenant-scoped reference): surrogate `uuid` pk, `tnnt_` id, bank_merchant_reference, `mrch_` id, vpa_hint (dedup hint only, never identity, D116/I1), created_at. UNIQUE(`tnnt_` id, bank_merchant_reference). This is the DB-ENFORCED merchant dedup and the (tenant, reference) to `mrch_` resolver (Fork B). It is identity RESOLUTION, a distinct fact from sponsorship (T2), and carries no program_id. RLS: permissive read in v1 (write-gated) because the cross-Program merchant-reuse read must span the tenant's Programs; tenant-portal predicate deferred to step 9.
* `tenant` (`tnnt_`) (platform/reference): `tnnt_` id, display_name, bank_reference_code (the bank's short identifier from the file; a display and matching aid, not a `bank_` counterparty id), status, created_at. UNIQUE(bank_reference_code). The sponsor bank as a portal-access tenant (I5).
* `program` (`prog_`) (Program-scoped by its own program_id): `prog_` id, owning `tnnt_` id, product_type (`soundbox_dispatch`), status, created_at. UNIQUE(`tnnt_` id, product_type). STATED V1 ASSUMPTION: one Program per bank per product for the soundbox, so the Program is derivable from (tenant, product) with no program discriminator in the row fact; this is not a corpus law and is cheap to relax (drop the unique, add a scheme discriminator to the row fact). RLS predicate on `program_id`. The sponsorship wrapper; a Program belongs to one tenant.
* `enrollment` (Program-scoped, 07.A class 1, the sponsorship relationship only): surrogate `uuid` pk, `mrch_` id, `prog_` id, `tnnt_` id (denormalized for the fact and the read gate), status (ACTIVE/SUSPENDED), created_at, updated_at. UNIQUE(`prog_` id, `mrch_` id). RLS predicate on `program_id`. Resolution and the bank reference live in `merchant_bank_ref`, not here (T2).
* `outbox` (E1), `inbox` (E6): the `@andpay/outbox` tables, unchanged from spec 02.

## 3. IDs minted

`mrch_`, `tnnt_`, `prog_` (all registered to Platform/Identity in the Section 11 registry, minted in-process at creation via `@andpay/ids`, D119 codec). The `enrollment` and the `merchant_bank_ref` resolver both use a surrogate `uuid` primary key, NOT a registry prefix (I3/I4; the spec-04 precedent for non-party surrogate keys). Identity-min does NOT mint `bank_` (Counterparty Directory's namespace, not built in the soundbox; D116 no-foreign-namespace). No new prefix is introduced.

## 4. Events

* Produced (all JSON on Glue at FULL compat, E4 envelope, D120):
  * `fct.identity.merchant.v1`, partition key `mrch_` id (E5, identity events ordered per merchant). Fields: event_type (MerchantCreated/MerchantUpdated), `mrch_` id, display_name, legal_name, mcc, registered_address (minimized), activation_state, status. IDs-and-minimal, NO KYC/PAN/GSTIN (S7, K3).
  * `fct.identity.tenant.v1`, partition key `tnnt_` id. Fields: `tnnt_` id, display_name, bank_reference_code, status.
  * `fct.identity.program.v1`, partition key `prog_` id. Fields: `prog_` id, `tnnt_` ref, product_type, status.
  * `fct.identity.enrollment.v1`, partition key `mrch_` id (ordered per merchant). Fields: enrollment id, `mrch_` id, `prog_` id, `tnnt_` id, status, and the source-row correlation id (the consumed row fact's `{file_id}|{row_no}` / source_event_id) so TMS-thin can attach its assignment to the resolved `mrch_` at step 6 without a C4 read. This is the sponsorship-relationship fact (I5). The bank_merchant_reference and vpa_hint stay in the `merchant_bank_ref` resolver, off the public fact (T2, S7).
* Consumed:
  * The TMS-thin bank-file ingest row fact (contract co-defined here; produced by TMS-thin at step 6, driven by a test fixture at step 5). Required fields Identity-min reads: the merchant slice (bank_merchant_reference, display_name, legal_name, mcc, registered_address), the tenant slice (bank_reference_code), the Program slice (product_type), and the vpa hint. Effect: resolve (tenant_id, bank_merchant_reference) in `merchant_bank_ref`; on hit reuse the `mrch_`, on miss mint a `mrch_` and insert the resolver row (the UNIQUE guards a concurrent double-mint, on conflict re-resolve to the winner); upsert tenant and Program; ensure the (`mrch_`, `prog_`) enrollment; then emit the identity facts, all in one transaction (E1). Inbox dedup key: the source row fact's `{file_id}|{row_no}` idempotency key (06.A, stamped by TMS per D116), so a redelivered row is a no-op (E6).

## 5. Commands

None. Identity-min is not an orchestrator and drives no saga (O2). The upsert is an event-driven consume-project-emit, not a command.

## 6. Ports and adapters

No Processor Port, no Issuing Inbound Port, no Settlement File Ingest, no external vendor adapter. The bank-file ingest channel is TMS-thin's (D116); Identity-min consumes the resulting fact and holds NO file adapter and no vendor schema inland (T11). Pure fact-in, fact-out.

## 7. Ledger interaction

NO LEDGER, NO MONEY. Identity-min holds no posting capability (the M4 grant subject is a workload SVID, never this context, 5f/M11). Idempotency is a deterministic 06.A key on the consumed row fact, not an M7 posting floor.

## 8. Auth surface

Identity-min serves NO principal directly in v1 (no HTTP shell; portals wire HTTP at step 9). The consume-project-emit runs as an internal workload authorized at the bus by its SVID (S11, S12), never a human or edge principal. It consumes no D3 claims in v1. No new audience, no RLS-exempt need (4c), no step-up catalog entry. The Auth fact-read seam stays stubbed (Fork C): Identity-min publishes `fct.identity.merchant.v1` and `fct.identity.enrollment.v1`, which are the facts a future class-1/2/4 auth path would project; the Auth-side consumer is NOT built in v1.

## 9. Isolation and residency

`program_id` RLS predicate on `enrollment` and `program` (07.A class 1), write-gated `WITH CHECK (program_id = current_setting('app.program_id', true)::uuid)` with `SET LOCAL app.program_id` before every Program-scoped write (07.B); reads stay open in v1 so the cross-Program merchant-reuse resolve works. `merchant`, `merchant_bank_ref`, and `tenant` are tenant-scoped and permissive-read in v1 (write-gated), the tenant-portal relationship-gated predicate deferred to step 9. FORCE RLS on all tables under the staged per-workload role (the spec-02/03/04 DB-boundary precedent). All stores India-resident (S6), verified static now (cdk synth), live proof at deploy (the spec-03/04 precedent). PII posture (S7): every identity fact is IDs-and-minimal, NO KYC, NO PAN/GSTIN; registered_address is minimized reference identity and is redacted from any log line (S7, S4). The E4 `trace_id` from the consumed row fact propagates through the upsert to every emitted identity fact (S21).

## 10. Idempotency

* The upsert is idempotent on the consumed row fact key `{file_id}|{row_no}` via inbox dedup (E6) plus the DB-enforced resolver: merchant identity is matched by `merchant_bank_ref` UNIQUE(`tnnt_` id, bank_merchant_reference), the enrollment by UNIQUE(`prog_` id, `mrch_` id).
* A redelivered identical row fact re-runs as a no-op: no second `mrch_`, no second resolver row, no second enrollment, no duplicate identity fact.
* An existing `mrch_` receiving a new row for the same (tenant, bank_merchant_reference) is an identity no-op (D116: it becomes an additional ASSIGNMENT on the TMS side, not a new merchant); a concurrent first-seen double is caught fail-closed by the resolver UNIQUE and re-resolves to the single `mrch_`.
* A new Program for an existing merchant (same tenant, same reference) reuses the `mrch_` via the resolver and creates a NEW enrollment, never a new merchant (check 1d, I1, I5).

## 11. Gate citations

* Item 6 (each context owns its own data): Identity-min owns the `identity` schema; it consumes facts and performs NO cross-context DB read (C4, T7).
* One canonical merchant store, no relationship as an attribute: satisfied via I1 (one `mrch_` per entity), T2 (Identity is the sole owner of merchant identity), I5/T3 (sponsorship on the enrollment, never a merchant column), K2/K3 (no KYC copy, bank-held).
* Item 17 partial (isolation): FORCE RLS on the `identity` schema, `program_id` predicate on the Program-scoped tables; the merchant-global tenant-portal predicate is deferred to step 9.
* Item 28 (S23): expand-contract, reversible migrations; the initial `identity` migration is additive.
* Money items: N/A (no ledger, no M4).

## 12. Acceptance checks (each by RAW evidence, not a green summary)

Consumed row facts are driven by a TEST FIXTURE at step 5 (the real TMS-thin producer lands at step 6). Load-bearing items to show in raw mechanism form: checks 1, 2, and 4.

1. (LOAD-BEARING) Resolution, idempotency, and DB-enforced dedup. Resolution is by (tenant, bank_merchant_reference). (a) A fixture row fact creates exactly one `mrch_`, one `merchant_bank_ref` row, one enrollment. (b) A redelivered identical row fact is a no-op (inbox dedup: no second `mrch_`, resolver row, or enrollment, no duplicate fact). (c) A second row with the same (tenant, reference) under the SAME Program reuses the `mrch_` and is an identity no-op. (d) A row for the same (tenant, reference) under a NEW `prog_` reuses the `mrch_` and creates a new enrollment, no new `mrch_`, no new resolver row. (e) A concurrent or duplicate first-seen insert on the same (tenant, reference) is caught FAIL-CLOSED by `merchant_bank_ref` UNIQUE and re-resolves to the single `mrch_`. Raw: `mrch_`, `merchant_bank_ref`, and enrollment row counts before and after each case, and the raw unique-violation-then-resolve for (e).
2. (LOAD-BEARING) No sponsorship or bank reference on the merchant (I5, T3, T2). Raw `\d merchant` showing no tenant_id / bank_id / program_id / bank_merchant_reference column, plus a merchant row; raw `\d merchant_bank_ref` showing the (tenant, reference) to `mrch_` resolution lives there with its UNIQUE; raw `\d enrollment` showing the sponsorship (`prog_`, `mrch_`) with UNIQUE(`prog_`, `mrch_`).
3. VPA is a dedup hint, never identity (I1, D116). Two rows differing only by bank_merchant_reference but sharing a VPA under one `prog_` produce two `mrch_` and two `merchant_bank_ref` rows matched by the reference, not collapsed by the shared VPA; VPA carries no unique constraint in `merchant_bank_ref`. Raw.
4. (LOAD-BEARING) `fct.identity.merchant.v1` shape and FULL-compat (D120), no KYC. Emit the fact; show the JSON Schema registered at FULL compat, a type-change and a new-required-field rejected and an additive optional field accepted (reuse the spec-03 registry machinery, raw registry 409); show the fact carries NO KYC, PAN, or GSTIN (S7, K3). Raw payload plus registry output.
5. Partition key = `mrch_` id (E5). Identity facts for one merchant land on the same partition, ordered. Raw.
6. Residency and PII redaction. `identity` stores pinned India-resident (cdk synth, deploy-deferred live proof); registered_address redacted before the first log line (S7, S4); facts IDs-and-minimal. Raw redaction plus static residency test.
7. E1 atomicity of upsert-plus-emit. The merchant upsert and the `fct.identity.merchant.v1` outbox enqueue commit in one transaction: 0 rows after a rolled-back operation, 1 after commit, reusing `@andpay/outbox`. Raw.
8. Bank is `tnnt_`, not `bank_` (D116, I5). Show Identity-min mints a `tnnt_` for the sponsor bank and mints/references no `bank_` id; the enrollment references `tnnt_` and `prog_`. Raw ids.
9. E4 `trace_id` propagation (S21). The `trace_id` on the consumed row fact appears on all four emitted identity facts. Raw.

## 13. DO-NOT list

* No product calls a product (C2, T1); Identity-min consumes facts and never calls TMS, Fulfillment, or Auth.
* No cross-context DB read (C4, T7); Identity reads facts, never another context's tables.
* No KYC copy, reference only (K2, K3); Identity-min holds NO KYC in the bank-sponsored path, ever.
* No relationship as an entity attribute (T3, I5); the bank and Program sponsorship live on the enrollment, never a merchant column, never `parent_merchant_id`.
* VPA is never the merchant identity key (I1, D116); it is a dedup hint only.
* No new prefixes without a decision (I3, I4); `mrch_`, `tnnt_`, `prog_` are registered, the enrollment is a surrogate uuid, and `bank_` is NOT minted (Counterparty Directory's namespace, D116).
* No KYC, PAN, GSTIN, or PII in facts, logs, events, or IDs (S7, K3, S4); redact reference identity before the first log line.
* No money, no ledger, no M4 (5f, M11).
* No runtime control plane; config-as-code, CODEOWNERS-gated (S23).
* No em-dashes in any document, comment, or commit message.

## Verification cadence

Claude Code runs on Bhupender's machine; this chat cannot see the repo. On completion, paste RAW output for the nine acceptance checks (a green summary is a claim, not evidence). Load-bearing in raw mechanism form: upsert idempotency and dedup (check 1), no sponsorship attribute on the merchant (check 2), and the merchant fact shape plus FULL-compat plus no-KYC (check 4). On consistent evidence, flip the Identity Registry row to BUILT-V1 (scoped to the v1 minimal slice) in `platform_build_state.md` with a milestone line; then the D118 sequence continues at step 6 (TMS-thin). Registered deferrals: the live ap-south-1/2 residency proof (deploy); the merchant-global tenant-portal relationship-gated RLS predicate (lands with the class-2 read surface at step 9); the Auth-side fact-read consumer (stubbed until a class-1/2/4 product, Fork C); the real TMS-thin row-fact producer (step 6, fixture-driven now); PAN/GSTIN dedup for direct Programs (when we own KYC).
