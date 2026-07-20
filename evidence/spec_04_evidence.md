# Spec 04 (Auth slice) evidence

> Raw acceptance evidence for handoff spec 04. Committed OUTSIDE docs/ (docs/ is
> gitignored per the owner's choice). Repo-side record; the authoritative
> BUILT-V1 flip in platform_build_state.md is the plan chat's to make. Claude Code
> does NOT self-flip BUILT-V1. Raw output below; a green summary is a claim.

## Full-suite verification (raw)
```
pnpm build      -> exit 0 (all packages + services/auth)
pnpm lint       -> exit 0 (clean)
pnpm typecheck  -> exit 0 (no errors)
pnpm test       -> Test Files  23 passed (23)
                   Tests      143 passed (143)
                   Type Errors  no errors
```
Local stack: postgres:16 (5432) + redpanda (kafka 19092, schema registry 18081).

## Clarification: internal-principal `sub` is a bare surrogate uuid (Section 3, I3/I4)
`internal_principal.id` is `@db.Uuid`; `login()` sets the token `sub` to that uuid. There is no `prn_` prefix anywhere in the code or schema. The `prn_ops1` in the first evidence run was a hand-typed display literal passed as `principalId` in a since-deleted scratch script. Raw (check 1 below): `sub=bf3e2b8e-3c53-47ee-8f88-1b601f6ab730`, matches the bare-uuid regex.

## Ratified interpretive choices (locked with the plan chat before build)
A. Lean claim keys: `iss sub aud iat exp nbf jti` + `cls mode scope psr epoch acr amr auth_time`; `mode` per S2/S16; class-3 `scope` empty, ceiling from role via `psr` (4c/D121). B. `acr` AAL1/2/3; `amr` RFC 8176; WebAuthn to hwk. C. Audiences `andpay:internal-admin` (class-3 JWT) and `andpay:vendor` (class-6, at resolution, never a JWT). D. Class-3 roles support_readonly/ops/admin (AAL2), super_admin (AAL3, defined, login gated closed); class-6 vendor_manufacturer/vendor_print. E. `apsk_{live|test}_` + base64url(32 CSPRNG bytes) + 4-char checksum; stored only as the peppered HMAC; fingerprint = first 8 hex of `sha256(RAW SECRET)` (see check 5, ratification of E pending, no rework). F. 6e is an auth-internal `authz.audit` outbox record, never public; only `fct.auth.credential.v1` is public. G. jose, @node-rs/argon2, Node crypto, otplib (Section 4 swappable). H. access TTL 600s, class-3 refresh idle 1800s / absolute 28800s, step-up freshness 300s (RBI 15.B may tighten later). Plus: additive migration 0002 (06.A idempotency key, S23 expand-contract); eslint ignores `_`-prefixed interface-stub params.

## Acceptance checks (raw, grouped by test file)

### packages/authz/test/verify.test.ts (9) -> CHECK 1 (RFC 8725) + CHECK 4 (JWT denylist)
```
header : {"alg":"ES256","kid":"dev-1","typ":"at+jwt"}
claims : {"cls":3,"mode":"live","scope":{},"psr":"role:admin","epoch":1,"acr":"AAL2","amr":["pwd","otp"],"auth_time":1800000000,"iss":"andpay-auth","sub":"bf3e2b8e-3c53-47ee-8f88-1b601f6ab730","aud":"andpay:internal-admin","iat":1800000000,"nbf":1800000000,"exp":1800000600,"jti":"06878eb6-4fe7-4881-9ee4-420f14d54a66"}
sub is a BARE surrogate uuid, no registry prefix: true
JWKS public-only (no "d"): {"kty":"EC","x":"-kIHG3zw...","y":"-y754uRs...","crv":"P-256","kid":"dev-1","alg":"ES256","use":"sig"}
LOCAL VERIFY OK: cls=3
wrong-aud       => token-verify-failed / JWTClaimValidationFailed
alg:none        => token-verify-failed / JOSEAlgNotAllowed
HS256 confusion => token-verify-failed / JOSEAlgNotAllowed   (HS256 signed with the EC public key material; verifier pins ES256)
RS256           => token-verify-failed / JOSEAlgNotAllowed
wrong typ (JWT) => token-verify-failed / JWTClaimValidationFailed
(the token below is validly signed + unexpired; ONLY the denylist rejects it)
denylist by SUB => denylisted / denylisted
denylist by JTI => denylisted / denylisted
```

### services/auth/test/{login,issue-and-acr}.test.ts (3 + 8) -> CHECK 2 (acr gate)
```
computeAcr([pwd])       = AAL1
computeAcr([pwd,otp])   = AAL2
AAL2 floor vs AAL1 (password-only) => assurance-insufficient / requires AAL2, reached AAL1
super_admin AAL3 vs AAL2           => assurance-insufficient / requires AAL3, reached AAL2
integrated login password-only     => assurance-insufficient / requires AAL2, reached AAL1
integrated login password+TOTP     => acr=AAL2  session issued  token sub=da2a1c6a-...-9b0363f0fbe8 (bare uuid)
```

### services/auth/test/refresh-family.test.ts (4) -> CHECK 3 (session bounds)
```
rotate r0 -> r1 rows (used/revoked): [{"used":true,"revoked":false},{"used":false,"revoked":false}]
reuse rotated r0         => refresh-reuse-family-revoked
legit r1 after revoke    => refresh-revoked
family after reuse (all revoked): [true,true]
idle-expired (+1801s)    => refresh-idle-expired
absolute-expired (+3700s, idle still fresh, forces full re-auth) => refresh-absolute-expired
```

### services/auth/test/vendor-credential.test.ts (8) -> CHECK 5 + CHECK 4 (api_ denylist)
```
show-once secret          : apsk_live_GfdD9... (len 57)
stored peppered_hash == HMAC(secret, pepper): true
raw secret present in row : false
secret construction       : apsk_{live|test}_ + base64url(32 CSPRNG bytes) + 4-char checksum (as built)
fingerprint is sha256(RAW SECRET)[:8] (NOT the peppered HMAC, NOT the api_ id): true
grant ledger:post      => permission-not-in-class6-universe
grant kyc:attest       => permission-not-in-class6-universe
grant posture:loosen   => permission-not-in-class6-universe
grant api_keys:manage  => permission-not-in-class6-universe
grant device:activate  => permission-not-in-class6-universe
fail-closed unknown apsk_ => credential-unknown      (5e, distinct from both revoke paths)
fail-closed malformed     => mode-mismatch
resolve ACTIVE            : cls=6
credential status before denylist: ACTIVE (not revoked)
credential status after addToDenylist: ACTIVE (still ACTIVE; denylist is a DISTINCT channel)
resolve ACTIVE-but-denylisted api_ => denylisted             (CHECK 4, api_ path)
resolve after STATUS revoke        => credential-revoked     (distinct mechanism, 5d)
```

### services/auth/test/planes-scope-redaction.test.ts (7) -> CHECK 6 (planes) + CHECK 7 (no Identity read)
```
internal-admin JWT at vendor edge  => mode-mismatch          (a JWT is not an apsk_ secret; rejected at resolution)
class-6 resolved claim aud (plane) : andpay:vendor  (sub=api_01kxzysmtfeqcrzfcc828w5eya)
class-6 claim would be rejected on the internal-admin plane: true
apsk_ secret segment count (a JWT has 3): 1                  (class 6 is never minted a JWT)
class-3 authorize from config only (vendor_credential:create): true
class-6 authorize own work-queue   : true
class-6 authorize another queue    : false
(authorize + resolveVendorCredential take NO Identity reader; the Identity seam is unwired and throws)
```

### services/auth/test/authz-audit.test.ts (5) -> CHECK 8 (6e emission + E1 atomicity)
```
authn record   : {"id":"61ac...","acr":"AAL2","cls":3,"outcome":"authenticated","traceId":"trace-login","authTime":1800000000,"decision":"ALLOW","operation":"login","principalId":"da2a1c6a-..."}
DENY record    : {"id":"cd6b...","acr":"AAL2","cls":3,"outcome":"denied","traceId":"trace-deny","authTime":1800000000,"decision":"DENY","operation":"mfa:reset","reasonCode":"permission-denied","principalId":"da2a1c6a-..."}
issuance record: {"id":"ecb5...","acr":"AAL2","cls":3,"outcome":"issued","traceId":"trace-issue","decision":"ALLOW","operation":"vendor_credential:create","principalId":"da2a1c6a-...","resourceIds":["api_01kxzysmvve7...","vndr_01kxzysmsze6..."]}
any password / TOTP secret / apsk_ in the three records? false
E1: authz.audit rows after ROLLED-BACK operation: 0
E1: authz.audit rows after COMMITTED operation : 1
```

### CHECK 9 (residency + redaction): test/residency.test.ts (4) + planes-scope-redaction.test.ts
infra/aws AuthKeysStack pins the D3 signing key as a multi-region KMS key (D79) and the pepper (Secrets Manager) to ap-south-1/ap-south-2 behind the S6 residency guard; static residency guard green. Live `cdk synth`/deploy and its residency proof are the owner's (Claude Code runs no AWS command). `redactSecrets` scrubs `apsk_` tokens before the first log line (5c); the six audit records above carry no secret.

## Guard teeth (verified)
Planting `import '@prisma/client'` into @andpay/authz made the "holds no store" guard FAIL (1 failed | 9 passed); removing it returned all 10 guard tests green.

## Deferrals (registered, not skipped)
Live AWS multi-region KMS + Secrets Manager pepper + ap-south-1/2 residency live proof + SPIFFE/mTLS + broker ACLs (deploy); JWKS rotation; full 5d N-concurrent rotation; full step-up catalog; the 6e tamper-evident hash-chain/WORM store + integrity job (emission path and record shape built now); the NestJS HTTP shell; the Identity fact-read seam (stubbed, wired at Identity-min step 5); WebAuthn and SMS MFA adapters (interface-only, so AAL3 is unattainable and super_admin login is gated closed).

## Next
On consistent evidence, the plan chat flips the auth-slice and 6e-emission rows to BUILT-V1 in platform_build_state.md with a milestone line; D118 then continues at step 5 (Identity-min).
