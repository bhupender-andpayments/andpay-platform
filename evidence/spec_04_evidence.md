# Spec 04 (Auth slice) evidence

> Raw acceptance evidence for handoff spec 04. Committed OUTSIDE docs/ (docs/ is
> gitignored per the owner's choice). This is the repo-side evidence record; the
> authoritative BUILT-V1 flip in platform_build_state.md is the plan chat's to
> make. Claude Code does NOT self-flip BUILT-V1.

## Build state
- Status: BUILT, evidence provided 2026-07-20; AWAITING plan-chat ratification to
  flip the auth-slice and 6e-emission rows to BUILT-V1.
- Layer: platform service (Auth). Decision 118 build step 4. Decisions 105, 121;
  16.1 to 16.5; S10 to S15, S22, S23.
- Commits: incremental on main, one coherent unit each (see git log).

## Full-suite verification (raw)
```
pnpm build      -> exit 0 (all packages + services/auth built)
pnpm lint       -> exit 0 (clean)
pnpm typecheck  -> exit 0 (no errors)
pnpm test       -> Test Files  23 passed (23)
                   Tests      138 passed (138)
                   Type Errors  no errors
```
Local stack up: postgres:16 (5432) + redpanda (kafka 19092, schema registry 18081).

## REPO SHAPE delivered (spec Section 6)
- `@andpay/authz` (secret-free library, imported by every context): D3 claim types,
  local JWKS verify with RFC 8725 hardening, api_/apsk_ edge-resolve-to-claim, the
  denylist check, the D2 two-gate evaluator. Pure functions over injected material
  (JWKS, pepper, projection, denylist, role-config); holds no signing key, no
  pepper, no store, and never calls Auth.
- `services/auth` (sole secret-holder): the `auth` prisma schema (FORCE RLS), the
  KMS-signing / pepper / MFA ports with local dev adapters, config-as-code
  (roles, vendor sets, audiences, step-up catalog), token issuance + login + acr
  gate, the refresh-token family, the class-6 credential lifecycle + fact, and 6e
  authz-audit emission.

## Ratified interpretive choices (locked with the plan chat before build)
- A. Lean claim keys: OIDC-aligned `iss sub aud iat exp nbf jti` + `cls mode scope psr epoch acr amr auth_time`. `mode` added per S2/S16 (always present; class-3 v1 always live). Class-3 `scope` is empty; ceiling resolves from the role via `psr` (4c/D121).
- B. `acr` in {AAL1,AAL2,AAL3}; `amr` per RFC 8176 (pwd/otp/sms/hwk/swk); WebAuthn to hwk.
- C. Audiences: `andpay:internal-admin` (class-3 JWT), `andpay:vendor` (class-6, checked at resolution, never a JWT).
- D. Config seed: class-3 roles support_readonly/ops/admin (AAL2) plus super_admin (AAL3, defined but login gated closed, WebAuthn deferred); class-6 sets vendor_manufacturer/vendor_print.
- E. `apsk_{live|test}_` + base64url(32 CSPRNG bytes) + a 4-char checksum; stored ONLY as the peppered HMAC; the display fingerprint is the first 8 hex of a non-reversible hash (nothing raw stored).
- F. 6e authz-audit is an auth-INTERNAL outbox record (event_type `authz.audit`), never on the public fact bus; only `fct.auth.credential.v1` is public.
- G. Libraries (Section 4 swappable): jose (JWT/JWKS/ES256), @node-rs/argon2 (Argon2id password verifier), Node crypto (HMAC/CSPRNG), otplib (TOTP).
- H. Tunable defaults: access TTL 600s; class-3 refresh idle 1800s / absolute 28800s; step-up freshness 300s; S22 verify leeway 60s. (RBI admin-session clause 15.B may tighten later; a verify, not a change now.)
- Additive migration 0002 (S23 expand-contract): the 06.A idempotency key on vendor_credential.
- Tooling: eslint no-unused-vars now ignores `_`-prefixed identifiers (interface-mandated stub params).

## Acceptance checks (raw)

### Check 1: D3 issue + local JWKS verify + RFC 8725 rejections (LOAD-BEARING)
```
JWT header : {"alg":"ES256","kid":"dev-1","typ":"at+jwt"}
JWT claims : {"cls":3,"mode":"live","scope":{},"psr":"role:admin","epoch":1,"acr":"AAL2","amr":["pwd","otp"],"auth_time":1800000000,"iss":"andpay-auth","sub":"prn_ops1","aud":"andpay:internal-admin","iat":1800000000,"nbf":1800000000,"exp":1800000600,"jti":"cffa55ba-d26f-4b39-a258-8e02c562a09c"}
JWKS (public only, no "d"): {"kty":"EC","x":"z3aOCJINkIkk5O6YvijDIKswGuOGwDbJhfpKTO8s934","y":"OB9Z48SXmYPCuC2WPJngpaQn5lf0b0O-m_L0Ppl9x3U","crv":"P-256","kid":"dev-1","alg":"ES256","use":"sig"}
LOCAL VERIFY OK: cls=3 acr=AAL2 psr=role:admin mode=live
WRONG-AUD REJECTED: token-verify-failed
ALG:NONE REJECTED: token-verify-failed
```
Tests: packages/authz/test/verify.test.ts (6), services/auth/test/issue-and-acr.test.ts (8).

### Check 2: MFA and assurance acr gate (6a)
- A class-3 login with password only reaches AAL1 and is DENIED against the AAL2 platform floor; password + TOTP reaches AAL2 and issues a session (services/auth/test/login.test.ts, end to end against the DB).
- enforceRoleAssurance('AAL3', 'AAL2') throws: the super_admin path (requiredAcr AAL3, WebAuthn deferred) denies an AAL2 proof, so super_admin login is gated closed (services/auth/test/issue-and-acr.test.ts).

### Check 3: refresh-token family, reuse revokes the whole family (LOAD-BEARING)
```
rotate r0 -> r1: rows (used/revoked) = [{"used":true,"revoked":false},{"used":false,"revoked":false}]
REUSE of rotated r0 => refresh-reuse-family-revoked
legit r1 after family revoke => refresh-revoked
family after reuse (all revoked) = [true,true]
```
Tests: services/auth/test/refresh-family.test.ts (4, incl. idle and absolute bounds).

### Check 4: denylist rejects an otherwise-valid credential/token (D3)
- A denylisted sub or jti is rejected by verifyAccessToken even when the JWT is validly signed and unexpired (packages/authz/test/verify.test.ts).
- A denylisted api_ id fails resolveVendorCredential immediately though the credential is ACTIVE (services/auth/test/vendor-credential.test.ts; see check 5 raw).

### Check 5: class-6 peppered-HMAC storage + structural exclusion (LOAD-BEARING)
```
show-once secret         : apsk_live_bPa5p... (len 57)
api_ id (loggable)       : api_01kxzw21b1fc5r6xf7zg50vg0q
stored row               : {"peppered_hash":"598b131b038cc6be02f0...","fingerprint":"82a69315","status":"ACTIVE","mode":"live"}
stored HMAC == HMAC(secret, pepper): true
raw secret present in row?         : false
grant ledger:post => permission-not-in-class6-universe
grant kyc:attest => permission-not-in-class6-universe
grant posture:loosen => permission-not-in-class6-universe
grant api_keys:manage => permission-not-in-class6-universe
grant device:activate => permission-not-in-class6-universe
resolve ACTIVE           : cls=6
after status revoke => credential-revoked
```
Tests: services/auth/test/vendor-credential.test.ts (7, incl. idempotency and step-up).

### Check 6: distinct planes, class 6 never a JWT (105f)
- An internal-admin JWT presented at the vendor edge is rejected (not an apsk_ secret).
- A resolved class-6 credential carries aud `andpay:vendor`, never `andpay:internal-admin`.
- Issuance returns a single-segment apsk_ secret (not a three-segment JWT): class 6 is never minted a JWT.
Tests: services/auth/test/planes-scope-redaction.test.ts (7).

### Check 7: scope resolves with ZERO Identity read (LOAD-BEARING, D121)
```
class-3 authorize from config-as-code only (vendor_credential:create): true
class-6 scope from credential binding: vndr=vndr_01kxzw21b0ekya9wvf3tbr51f7 wq=wq-A
class-6 authorize own work-queue     : true
class-6 authorize another queue      : false
Identity fact-read seam when invoked : identity-seam-not-wired (unwired, never read in this slice)
```
Enforced structurally: authorize and resolveVendorCredential take no Identity input; the cross-schema guard forbids any services/identity import (test/architecture.test.ts).

### Check 8: 6e authz-audit emission via the outbox
- An authentication, every DENY, and a vendor-credential issuance each emit an IDs-only `authz.audit` outbox record committed with the operation; no password, TOTP, or apsk_ secret appears in any record (services/auth/test/authz-audit.test.ts, 4).

### Check 9: residency and secret redaction
- infra/aws AuthKeysStack pins the D3 signing key as a multi-region KMS key (D79) and the pepper (Secrets Manager) to ap-south-1/ap-south-2 behind the S6 residency guard; static residency guard test green (test/residency.test.ts, 4). Live cdk synth/deploy and its residency proof are the owner's (Claude Code runs no AWS command).
- redactSecrets scrubs apsk_ tokens before the first log line (5c); audit records and errors carry only codes/ids, never the presented secret (services/auth/test/planes-scope-redaction.test.ts).

## Guard teeth (verified)
Planting `import '@prisma/client'` into @andpay/authz made the "holds no store" guard FAIL (1 failed | 9 passed); removing it returned all 10 guard tests green. The @andpay/authz secret-free DO-NOT has teeth.

## Deferrals (registered, not silently skipped)
Live AWS multi-region KMS key + Secrets Manager pepper + ap-south-1/2 residency live proof + SPIFFE/mTLS + broker ACLs (deploy). JWKS rotation. Full 5d N-concurrent credential rotation. Full step-up catalog breadth. The 6e tamper-evident hash-chain/WORM store and periodic integrity job (the emission path and record shape are built now). The NestJS HTTP shell (the nine checks are mechanism-level; portals wire HTTP at step 9). The Identity/enrollment fact-read seam (stubbed interface, wired at Identity-min, step 5). WebAuthn and SMS MFA adapters (interfaces only, so AAL3 is unattainable and super_admin login is gated closed).

## Next
On consistent evidence, the plan chat flips the auth-slice and 6e-emission rows to BUILT-V1 in platform_build_state.md with a milestone line; the D118 sequence then continues at step 5 (Identity-min).
