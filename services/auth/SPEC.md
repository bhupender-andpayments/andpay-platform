# Handoff Spec 04: Auth slice (class-3 internal humans, class-6 vendor credentials, D3 token)

Claude Code implements this spec and never invents architecture (Decision 114). Governing corpus: `architure_context.md` Section 16 (Decisions 1 to 6, esp. 16.1 taxonomy, 16.3 the D3 token model, 16.5 sub-items 5a to 5f and 6a to 6e), Decisions 105 (class-6 vendor principal) and 121 (internal-principal ownership); `architecture_rules.md` S10 to S15, S23, C1, C4, T2, T3. This is a CHANGE spec (the Auth platform-service slice for the soundbox build, sequence step 4). It moves NO money (S20-adjacent: the soundbox build has no ledger). One spec, verified by raw evidence before any build-state flip.

## 1. Identity
The Auth context, built to the slice the soundbox needs: class-3 AndPayments internal-user authentication (ops portal, vendor-credential issuance) and the class-6 external fulfillment/vendor credential (vendor portal), issuing and verifying Decision-3 tokens, over the auth-owned internal-principal store and class-6 credential registry (Decision 121). Section 5 layer: platform service (Auth). Auth owns no merchant/tenant/customer identity (C1, S10); it owns internal-operator principals and class-6 credentials (D121) and resolves class-1/2/4 scope from Identity/enrollment facts (not in this slice).

## 2. Owned data
Auth owns the `auth` schema on the one-instance schema-per-context topology (spec 02), plus the mandatory `outbox`/`inbox` (E1, E6, `@andpay/outbox`). FORCE RLS with a per-workload least-privilege role (S13); most of this schema is platform-only (class-3 tables have no tenant scope, D121/4c). Tables:

* `internal_principal` (class-3 human): surrogate uuid id, login handle, password verifier (Argon2id, never plaintext, S4), status (ACTIVE/DISABLED, status not delete, 5d pattern), role reference (a role name resolved to a permission set from config-as-code, D2/S10), created/updated. No PII beyond the login handle needed to authenticate.
* `mfa_enrollment` (class-3): principal id, factor type (webauthn/totp/sms enum, phishing-resistance-ranked per 6a), credential reference or TOTP secret custodied in Secrets Manager (never in the row, S4), enrolled_at, status.
* `vendor_credential` (class-6): the `api_` record id (loggable, S14/5a), the `apsk_` secret NEVER stored raw (HMAC-SHA256 with a KMS/Secrets-Manager-custodied pepper, 5c), bound to one referenced `vndr_` id (Fulfillment-owned entity, D115, referenced not owned), an explicit static work-queue scope, one permission set from the class-6 universe, mode (live/test), epoch, status (ACTIVE/REVOKED, 5d), issued-by (the class-3 operator, actor-on-behalf, S13/105e), created/rotated.
* `refresh_token` (D3 family, classes 1/2/3): hashed at rest, one-time-use, client-bound, lineage/family id for family-wide revocation on reuse (6b). Only class-3 sessions are exercised in this slice.
* `denylist` (D3 emergency revocation): any principal id or jti, small async-replicated set, checked cheaply on the hot path (D3).
* `session` state as needed for idle/absolute bounds (6b), or derived from the refresh-token family.
The 6e authz-audit store: a minimal append-only `authz_audit` emission via the outbox (committed with the operation, IDs-only, S7). The full tamper-evident hash-chain/WORM hardening and the periodic integrity job (S15/6e) are DEFERRED; the emission path and record shape are built now.

## 3. IDs minted
`api_` (the class-6 credential record, per the Section 11 registry and S14/5a; the auth-owned loggable record id). Internal principals and refresh tokens use surrogate uuids, not registry prefixes. `apsk_live_`/`apsk_test_` is the show-once SECRET, NOT an ID and never UUIDv7-derived (S4, 5a). No new registry prefix is introduced; introducing one requires a decision first (I3, I4).

## 4. Events

* Produced: `fct.auth.credential.v1` for class-6 credential lifecycle (issued/rotated/revoked, IDs-only: `api_` id, `vndr_` ref, status, epoch, no secret) so downstream (vendor portal, Fulfillment) can react; partition key the `api_` id. Authz-audit facts to the 6e emission path (authn events, every DENY, sensitive-op decisions, MFA events, vendor issuance, IDs/enums only). All schemas JSON at FULL compat in the registry (D120).
* Consumed: none required for classes 3 and 6 in this slice (scope is config plus the auth-owned stores, D121). The Identity/enrollment fact-read seam (for classes 1/2/4 scope, S10) is stubbed with a documented interface and wired at Identity-min (step 5); it is NOT exercised here.

## 5. Commands
None. Auth issues tokens and resolves credentials on synchronous direct calls (the D3 issue path is off the hot path); it is not an orchestrator and drives no saga. Verification is LOCAL at every consumer via JWKS (D3, T4), not a call to Auth.

## 6. Ports and adapters

* KMS signing port (swappable, Section 4): ES256 signing of D3 access tokens. A LOCAL dev signing key behind the port for tests; the live multi-region AWS KMS key (ap-south-1 primary, ap-south-2 replica, same key id, D79) is applied at deploy (deploy-deferred, consistent with spec 03). Verifiers hold only the JWKS public key.
* Pepper custody port (Secrets Manager, swappable): the 5c HMAC pepper for the class-6 secret; local dev secret for tests, live custody at deploy.
* MFA factor adapters behind a port (webauthn/totp/sms), phishing-resistance-ranked (6a); SMS is fallback-only, never primary.
* No Processor Port, no Issuing Port, no Settlement ingest. No vendor schema inland (T11): the class-6 credential is AndPayments' own edge credential, never a vendor's API shape.
* SPIFFE/mTLS S2S substrate stays deploy-deferred (spec 03, S11/S12).
* REPO SHAPE (build-shaping, derived from D3 local-verify, 4a/T4 no-central-PDP, D118 shared libraries, D2 two-gate, 5a uniform-claim; not a new decision): two artifacts. `services/auth` is the SOLE secret-holder (the ES256 KMS signing key, the 5c pepper, the D121 stores, all issuance and lifecycle). `@andpay/authz` is a secret-free library imported by every context (Identity, TMS, Fulfillment, the portals) that makes NO call to Auth: the D3 claim-shape types, local JWKS verification with RFC 8725 hardening, the api_/apsk_ edge-resolve-to-claim function, the denylist check, and the D2 two-gate evaluator. Humans (classes 1/2/3) present a JWT and machine/vendor principals (classes 4/6) present api_/apsk_; both resolve to the IDENTICAL lean claim (5a) and run through the one evaluator. This edge-principal evaluator is kept SEPARATE from the workload posting authority (4b isWorkloadAuthorizedToPost, SVID plus the M4 allowlist); they are never merged. DISTRIBUTION: four locally-replicated, integrity-protected, async reads, none a hot-path call to Auth (T4, D78 pattern): JWKS public keys (rotation-tolerant, overlapping validity), the denylist set, the role-to-permission-set config, and at vendor edges the credential projection for apsk_ resolution. Auth publishes, verifiers subscribe. The `@andpay/authz` DO-NOT: no signing key, no pepper, no store, no business logic, no call to Auth.

## 7. Ledger interaction
NO LEDGER, NO MONEY. The soundbox build has no ledger; the auth slice grants no M4 posting capability. Class-6 money capability is UNREPRESENTABLE (5f, 105d): the M4 grant subject is a workload SVID, never an external principal. Idempotency where needed is deterministic keys per 06.A, not an M7 posting floor.

## 8. Auth surface
This IS the auth surface. Principal classes served: class 3 (internal humans) and class 6 (vendors).

* D3 token (16.3): self-contained ES256 JWT access tokens verified locally against JWKS; the lean claim shape (principal id plus class, scope, permission-set REFERENCE, epoch, standard envelope iss/sub/iat/exp/nbf/jti/aud); IDs-only claims (S10.5, no PII, no secrets); DISTINCT `aud` per plane (internal-admin plane for class 3, a separate vendor plane for class 6, so a resolved class-6 claim can never replay against the internal plane. Class 6 is a bearer edge credential resolved LOCALLY to the uniform claim (5a direct-bearer, 5f no session, 105b/5e edge-local resolution) and is NEVER minted a JWT; the plane binding is checked at resolution); RFC 8725 hardening MANDATORY (reject `alg:none`, pin the algorithm at every verifier, validate iss/aud/exp/nbf/iat/typ, safe `kid`).
* `acr`/`amr` enum claims (6a): class 3 MANDATORY MFA at the AAL2 floor, no opt-out; super-admin MANDATORY AAL3. Factor strength matched to blast radius.
* Sessions (6b, classes 1/2/3): the D3 refresh-token family (opaque, rotating, one-time-use, hashed, client-bound, family-wide revocation on reuse), IDLE plus ABSOLUTE bounds enforced at the refresh call off the hot path. Class-3 sessions exercised here.
* Step-up (6b): minimal catalog with the soundbox entries only, class-6 vendor-credential creation and MFA enrollment/reset, expressed as min-`acr` plus `auth_time` freshness. Full catalog breadth deferred.
* Revocation (D3): short access-TTL primary bound plus the emergency denylist (any principal/jti). Class-6: status-based revoke plus the denylist channel are IN; 5d N-concurrent zero-downtime rotation is deferred behind the seam.
* Class-6 (105): edge credential reusing the 5a to 5e primitive, vendor-plus-work-queue scoped, money/KYC-attestation/posture/`api_keys:manage`/activation STRUCTURALLY outside its permission universe (105d, not merely ungranted), internal-operator-issued (class 3, logged actor-on-behalf, S13/105e), distinct audience. Local edge resolution against the async-replicated projection, fail-closed for authentication (5e).
* RLS-exempt needs: none for the human path; the auth slice is not RLS-exempt (4c/S13).

## 9. Isolation and residency
The `auth` schema, the credential projection, and all stores are India-resident (S6). Claims and audit records are IDs-only, never PII or secrets (S7, S10.5); the class-6 secret and any MFA secret are redacted before the first log line (5c, S4). FORCE RLS on the `auth` schema with a per-workload role (S13); `SET LOCAL` discipline where any Program-scoped data is touched (none in this slice). The E4 `trace_id` propagates through issuance, verification, and every audit event (S21).

## 10. Idempotency

* Token issuance is not money-mutating; a retried issue mints a fresh token, which is fine.
* Class-6 credential creation is idempotent on a deterministic key per 06.A (an operator retry does not mint a second secret for the same request).
* Refresh rotation is one-time-use: a reused refresh token revokes the whole family (6b), which is the anti-replay mechanism, not a dedup.
* 6e authz-audit emission rides the outbox committed with the operation (E1); at-least-once with consumer-side idempotency (E6).

## 11. Gate citations

* Item 20 and 21 (auth/authz: the D3 token model, the two-gate scope-plus-permission evaluation, distinct audiences, IDs-only claims) satisfied for classes 3 and 6.
* Item 6 (each context owns its own data): Auth owns the `auth` schema; no cross-context DB read (C4); the Identity fact-read is a stubbed seam, not a DB read.
* Item 17 partial (isolation): FORCE RLS on `auth` with a per-workload role; no Program-scoped data in this slice.
* Item 28 (S23): expand-contract, reversible migrations; the initial `auth` migration is additive.
* Money items: N/A (no ledger, no M4).

## 12. Acceptance checks (each demonstrated by RAW evidence, not a green summary)

1. D3 token issue and local verify: issue a class-3 access token signed by the KMS-port dev key, verify it locally against the JWKS public key, show the lean claim shape and that `alg:none` and a wrong-`aud` token are both REJECTED (RFC 8725, distinct-audience). Raw token header/claims and the rejections.
2. MFA and assurance (6a): a class-3 login without a second factor cannot reach AAL2 and is denied for platform access; an AAL3-required super-admin path denies an AAL2 token. Show the `acr` gate.
3. Refresh-token family (6b): a normal rotation issues a new refresh token and invalidates the old; REUSE of a rotated refresh token revokes the entire family. Raw before/after.
4. Denylist (D3): a denylisted principal id or jti is rejected on the hot path though the JWT is otherwise valid and unexpired. Raw.
5. Class-6 credential (105, 5a to 5e): issue a vendor credential (show-once `apsk_`), verify the stored form is the peppered HMAC and never the raw secret, resolve it at the edge fail-closed, and show money/KYC/posture/`api_keys:manage`/activation are STRUCTURALLY absent from its permission universe (an attempt to grant one is rejected, not silently ungranted). Show status-based revoke takes effect and the denylist kills it immediately.
6. Distinct planes: a resolved class-6 credential is rejected against the internal-admin plane and an internal-admin token is rejected at the vendor edge; the plane binding is enforced at resolution, class 6 is never minted a JWT (105f, 5a, 5f, S10).
7. Ownership and scope without Identity (D121): show class-3 scope resolves from config-as-code role-to-permission-set and the scope-ceiling, and class-6 scope from the credential's work-queue binding referencing a (seeded/test) `vndr_`, with ZERO read of any merchant-Identity store or fact.
8. 6e emission: an authentication, a DENY, and a vendor-credential issuance each emit an IDs-only authz-audit record via the outbox, committed with the operation, no PII or secret in the record.
9. Residency and secrets: stores are ap-south-1 (cdk synth, deploy-deferred live proof); the class-6 secret and MFA secret are redacted before the first log line.

## 13. DO-NOT list

* Auth owns NO merchant/tenant/customer identity (C1, S10); it reads those as facts, never a cross-context DB read (C4). The Identity fact-read is a stubbed seam here.
* No product calls a product (C2, T1); verification is local via JWKS, never a call to Auth (T4).
* No PII and no secrets in claims, tokens, audit records, logs, events, or IDs (S7, S10.5, S4); redact before the first log line (5c). The class-6 secret is show-once and stored only as a peppered HMAC (5c).
* No symmetric token signing (every verifier would hold a minting secret); ES256 only, key in the KMS port (D3).
* No `alg:none`, no unpinned algorithm, no skipped iss/aud/exp/nbf/typ validation (RFC 8725, S10).
* No MFA on machine or vendor credentials (6a): assurance IS the credential for classes 4/5/6; MFA lives on the human edge (5f).
* Class-6 money capability is UNREPRESENTABLE, not merely ungranted (5f, 105d); likewise KYC-attestation, posture, `api_keys:manage`, and activation are outside the class universe.
* No vendor self-service credential issuance; class-6 issuance is a class-3 operator action, logged actor-on-behalf (105e, S13).
* No runtime control plane for roles, permission sets, the step-up catalog, or audiences; config-as-code, CODEOWNERS-gated, CI-deployed (S23).
* No shared audience across planes (S10, 105f).
* No em-dashes in any document, comment, or commit message.

## Verification cadence
Claude Code runs on Bhupender's machine; this chat cannot see the repo. On completion, paste RAW output for the nine acceptance checks (a green summary is a claim, not evidence). Load-bearing items to show in raw mechanism form: the `alg:none`/wrong-`aud` rejection and JWKS local verify (check 1), the refresh-family reuse revocation (check 3), the class-6 peppered-HMAC storage and structural permission exclusion (check 5), and the zero-Identity-read scope resolution (check 7). On consistent evidence, flip the auth-slice and 6e-emission rows to BUILT-V1 in `platform_build_state.md` with a milestone line; then the D118 sequence continues at step 5 (Identity-min). KMS, SPIFFE/mTLS, JWKS rotation, full 5d rotation, full step-up catalog, and the 6e tamper-evident hardening are registered deferrals to deploy or a later hardening pass.
