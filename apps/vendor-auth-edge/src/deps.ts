import { randomUUID } from 'node:crypto'
import {
  PrismaClient as AuthClient,
  type AuthDb,
  type KmsSigningPort,
  type MfaAdapter,
  LocalEs256Adapter,
  TotpAdapter,
  loadConfig,
  INTERNAL_ADMIN_PLANE,
  VENDOR_PLANE,
} from '@andpay/auth-service'
import type { Mode, RoleConfig } from '@andpay/authz'
import type { JSONWebKeySet } from 'jose'
import { type ThrottlePort, InMemoryTokenBucket } from './throttle.js'

// Token-provided deps (NO type-reflection DI: esbuild drops
// emitDecoratorMetadata under vitest, so every injectable here reads its deps
// off one explicit token), mirroring apps/auth-edge/src/deps.ts. Like
// auth-edge, vendor-auth-edge is a token PRODUCER: it holds the
// highest-privilege seam (`signer`) as well as the LOCAL verify keyset
// (`jwks`) it uses on its own refresh/logout/enroll-guard routes.
//
// Fork D (spec 14a task 2): `signer` here is the MULTI-KEY signer
// (`LocalEs256Adapter.createMulti`) holding BOTH the internal-admin and
// vendor signing keys, so `jwks` (always `await signer.jwks()`, never an
// independently-sourced value) publishes BOTH public keys. This edge itself
// mints ONLY `aud:'andpay:vendor'` tokens (the unknown-aud path inside
// `SelectingSigner.sign` is unreachable from this edge's own controllers);
// the internal-admin key is carried in the signer purely so the aggregated
// JWKS this edge publishes is the same superset any verifier edge
// (ops/tenant/vendor) can validate either audience's token against (D6).
export interface VendorAuthEdgeDeps {
  // The auth-context DB (D121, C4): vendor_operator, mfa_enrollment,
  // refresh_token, denylist, session, authz_audit, outbox. Injected once at
  // process start, never opened per request.
  authDb: AuthDb
  // The KMS ES256 multi-key signer (highest privilege, mints tokens).
  // Swappable behind the KmsSigningPort interface; the real multi-region AWS
  // KMS adapter is a deploy-time concern, not built in this repo yet.
  signer: KmsSigningPort
  // The public keyset for LOCAL verify on refresh/logout/enroll-guard (this
  // edge verifies its OWN previously-minted tokens, zero call to Auth on the
  // request path). For the multi-key signer this is always
  // `await signer.jwks()`, never an independently-sourced value.
  jwks: JSONWebKeySet
  // The enrolled second-factor adapter (TotpAdapter in this slice).
  mfa: MfaAdapter
  // Custody seam (S7), keyed by (principalId, principalType): resolves the
  // vendor_operator's enrolled factor secret from Secrets Manager in
  // production. Carry-forward 3 (spec 14a task 5): a (principalId,
  // principalType)-keyed resolver, NOT a principalId-only resolver, so a
  // vendor_operator's secret is fetched distinctly from any internal
  // principal that happens to share the same principalId value.
  // Resolves a custodied secret from an enrollment row's OWN reference (see the
  // internal auth-edge deps for why a per-principal key was unsafe).
  resolveSecretRef: (secretRef: string) => Promise<string | undefined>
  // Custody seam (S7): persists a freshly-generated secret to Secrets
  // Manager, returns only the reference. The raw secret NEVER touches the DB
  // row or a log line. The optional third argument mirrors enrollTotp's
  // storeSecret signature (spec 14a task 5): the principalType keys the
  // custody entry distinctly from an internal principal sharing the same id.
  storeSecret: (principalId: string, secret: string, principalType?: string) => Promise<string>
  // The pinned issuer this edge asserts on mint and checks on verify (D3/S10
  // RFC 8725 hardening).
  expectedIss: string
  // The live/test plane this edge serves (S16). Live-only in v1.
  expectedMode: Mode
  // The class-7 vendor role config (vendorSets), resolved LOCALLY.
  roleConfig: RoleConfig
  // Access token TTL in seconds (600 in v1).
  accessTtlSec: number
  // Refresh-family idle window in seconds (1800 in v1).
  idleSec: number
  // Refresh-family absolute window in seconds (28800 in v1).
  absoluteSec: number
  // The otpauth issuer label shown in the authenticator app.
  totpIssuer: string
  // The single allow-listed browser origin for the EXTERNAL vendor portal
  // (spec 14b), distinct from the internal ops-portal origin. Never a
  // wildcard; fails the process start closed if absent.
  vendorPortalOrigin: string
  // The 6d source-token-bucket seam. Defaults to NoThrottle until overridden
  // by a test; see throttle.ts.
  throttle: ThrottlePort
}

export const EDGE_DEPS = 'VENDOR_AUTH_EDGE_DEPS'

export const DEFAULT_AUTH_DATABASE_URL = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'

// v1 fixed token/session lifetimes (spec 04, mirrored by every login test in
// services/auth). Not sourced from env: these are protocol constants, not
// per-deploy config, so there is no env-derived value to drift from the
// service's own assumptions.
const ACCESS_TTL_SEC = 600
const IDLE_SEC = 1800
const ABSOLUTE_SEC = 28800

// 6d source-throttle defaults. A per-source token bucket: ~10 tokens absorbs
// a legitimate retype/refresh burst from one IP, while ~0.5 tokens/sec (one
// every two seconds) sustains a real user yet starves an automated
// password-spray. Plain numeric config (no secret), env-overridable per
// deploy. The key is the SOURCE IP, never the credential, so this never
// locks out a principal.
const THROTTLE_CAPACITY = 10
const THROTTLE_REFILL_PER_SEC = 0.5

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number when set (6d throttle config)`)
  }
  return parsed
}

// The real bootstrap's deps (main.ts only; never exercised by a test, which
// builds its own VendorAuthEdgeDeps via test/helpers.ts with a jose-generated
// multi-key signer and test-scoped clients). The issuer, portal origin, and
// signer identity are never defaulted in code (S4): each is required and
// fails the process start closed if absent.
//
// The real AWS KMS signing adapter and the real Secrets Manager custody
// adapter are both deploy-time concerns; neither exists anywhere in this
// repo yet. Until they land, this builder wires the same LocalEs256Adapter
// pattern apps/auth-edge uses and an in-process Map every test uses: each
// process's private key material is generated fresh at process start (never
// baked into code) and the vault never leaves process memory.
//
// KNOWN SCAFFOLD LIMITATION (documented, not a silent regression): the
// internal-admin key held here (purely so this edge's own JWKS publishes
// BOTH audiences' public keys, Fork D) is generated FRESH in THIS process and
// is therefore a DIFFERENT keypair than the one apps/auth-edge actually
// mints internal-admin tokens with. A real deployment shares ONE call to the
// KMS signing service across every edge process (the deploy-time adapter),
// so every edge's JWKS agrees on the same two public keys; that shared
// adapter does not exist yet. Until it lands, this process's published
// internal-admin public key is self-consistent (nothing here signs an
// internal-admin token and expects a DIFFERENT process to verify it) but is
// NOT the same key material auth-edge itself publishes. A process restart
// also mints new signing keys for both audiences, so tokens issued before a
// restart stop verifying after one, and the custody vault does not survive a
// restart or span replicas. All of this closes when the deploy-time KMS and
// Secrets Manager adapters land.
export async function buildVendorAuthEdgeDepsFromEnv(): Promise<VendorAuthEdgeDeps> {
  const vendorSigningKid = process.env.VENDOR_AUTH_SIGNING_KID
  if (!vendorSigningKid) {
    throw new Error('VENDOR_AUTH_SIGNING_KID is required (the signer identity is never defaulted in code, S4)')
  }
  const expectedIss = process.env.VENDOR_AUTH_ISS
  if (!expectedIss) {
    throw new Error('VENDOR_AUTH_ISS is required (the pinned issuer is never defaulted in code, D3/S10)')
  }
  const vendorPortalOrigin = process.env.VENDOR_PORTAL_ORIGIN
  if (!vendorPortalOrigin) {
    throw new Error('VENDOR_PORTAL_ORIGIN is required (the CORS allow-listed origin is never defaulted in code)')
  }
  // The vendor plane is LIVE-ONLY in v1 (S16, mirrors auth-edge/ops-edge/
  // tenant-edge): a future test plane is a config flip, not a retrofit.
  const expectedMode: Mode = 'live'
  const authUrl = process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL
  const totpIssuer = process.env.VENDOR_AUTH_TOTP_ISSUER ?? 'AndPayments'

  // Fork D multi-key signer: the vendor key (configured, distinct kid) plus a
  // scaffold-only internal-admin key (see the doc comment above) so jwks()
  // publishes both audiences' public keys.
  const vendorAdapter = await LocalEs256Adapter.create(vendorSigningKid)
  const internalShadowAdapter = await LocalEs256Adapter.create(`${vendorSigningKid}-internal-shadow`)
  const signer = LocalEs256Adapter.createMulti({
    [INTERNAL_ADMIN_PLANE]: internalShadowAdapter,
    [VENDOR_PLANE]: vendorAdapter,
  })
  const jwks = await signer.jwks()

  // The custody vault: an in-process Map, scaffold-only (see the doc comment
  // above). storeSecret and resolveSecretRef share this ONE map so a secret
  // enrolled via this process is resolvable at login in the SAME process.
  // Keyed by (principalId, principalType) so a vendor_operator's secret never
  // collides with an internal principal sharing the same id value.
  const vault = new Map<string, string>()
  // A UNIQUE reference per enrollment, for the same reason as the internal
  // edge: enrollments must not share a custody key.
  const storeSecret = async (principalId: string, secret: string, principalType = 'vendor_operator'): Promise<string> => {
    const ref = `vault://${principalType}/${principalId}/${randomUUID()}`
    vault.set(ref, secret)
    return ref
  }
  const resolveSecretRef = async (secretRef: string): Promise<string | undefined> => vault.get(secretRef)

  return {
    authDb: new AuthClient({ datasourceUrl: authUrl }),
    signer,
    jwks,
    mfa: new TotpAdapter(),
    resolveSecretRef,
    storeSecret,
    expectedIss,
    expectedMode,
    roleConfig: loadConfig(),
    accessTtlSec: ACCESS_TTL_SEC,
    idleSec: IDLE_SEC,
    absoluteSec: ABSOLUTE_SEC,
    totpIssuer,
    vendorPortalOrigin,
    // The deployed edge is throttled by default (6d): a per-source token
    // bucket, in-process (scaffold-only, like the vault above; a shared
    // store is a deploy-time swap behind the same ThrottlePort). It fails
    // OPEN in the login controller on its own failure, so auth still serves.
    throttle: new InMemoryTokenBucket({
      capacity: readPositiveNumber('VENDOR_AUTH_THROTTLE_CAPACITY', THROTTLE_CAPACITY),
      refillPerSec: readPositiveNumber('VENDOR_AUTH_THROTTLE_REFILL_PER_SEC', THROTTLE_REFILL_PER_SEC),
    }),
  }
}
