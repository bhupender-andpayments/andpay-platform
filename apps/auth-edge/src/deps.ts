import {
  PrismaClient as AuthClient,
  type AuthDb,
  type KmsSigningPort,
  type MfaAdapter,
  LocalEs256Adapter,
  TotpAdapter,
  loadConfig,
} from '@andpay/auth-service'
import type { Mode, RoleConfig } from '@andpay/authz'
import type { JSONWebKeySet } from 'jose'
import { type ThrottlePort, InMemoryTokenBucket } from './throttle.js'

// Token-provided deps (NO type-reflection DI: esbuild drops
// emitDecoratorMetadata under vitest, so every injectable here reads its deps
// off one explicit token, mirroring ops-edge/tenant-edge exactly). Unlike the
// three existing edges (token CONSUMERS, verify-only, no signer), auth-edge is
// the token PRODUCER: it holds the highest-privilege seam (`signer`) as well
// as the LOCAL verify keyset (`jwks`) it uses on its own refresh/logout/
// enroll-guard routes, so both a signer and a jwks are wired here, not just a
// jwks.
export interface AuthEdgeDeps {
  // The auth-context DB (D121, C4): internal_principal, mfa_enrollment,
  // refresh_token, denylist, session, authz_audit, outbox. Injected once at
  // process start, never opened per request.
  authDb: AuthDb
  // The KMS ES256 signer (highest privilege, mints tokens). Swappable behind
  // the KmsSigningPort interface; the real multi-region AWS KMS adapter is a
  // deploy-time concern (kms-signing.ts), not built in this repo yet, so the
  // env builder below wires the same LocalEs256Adapter every test uses.
  signer: KmsSigningPort
  // The public keyset for LOCAL verify on refresh/logout/enroll-guard (this
  // edge verifies its OWN previously-minted tokens, zero call to Auth on the
  // request path, T4/S14/5e). For a single-process signer this is always
  // `await signer.jwks()`, never an independently-sourced value (a
  // separately-configured JWKS could silently drift from the signer that
  // mints the tokens it must verify).
  jwks: JSONWebKeySet
  // The enrolled second-factor adapter (TotpAdapter in this slice).
  mfa: MfaAdapter
  // Custody seam (S7): resolves the principal's enrolled factor secret from
  // Secrets Manager in production. The row holds only secret_ref, never the
  // secret.
  mfaSecretResolver: (principalId: string) => Promise<string | undefined>
  // Custody seam (S7): persists a freshly-generated secret to Secrets Manager,
  // returns only the reference. The raw secret NEVER touches the DB row or a
  // log line.
  storeSecret: (principalId: string, secret: string) => Promise<string>
  // The pinned issuer this edge asserts on mint and checks on verify (D3/S10
  // RFC 8725 hardening).
  expectedIss: string
  // The live/test plane this edge serves (S16). Live-only in v1.
  expectedMode: Mode
  // The class-3 human role config (S15, D2, 4c) for the enroll admin
  // authorize + step-up checks, resolved LOCALLY (T4).
  roleConfig: RoleConfig
  // Access token TTL in seconds (600 in v1).
  accessTtlSec: number
  // Refresh-family idle window in seconds (1800 in v1).
  idleSec: number
  // Refresh-family absolute window in seconds (28800 in v1).
  absoluteSec: number
  // The otpauth issuer label shown in the authenticator app.
  totpIssuer: string
  // The single allow-listed browser origin for the login portal (spec 12
  // task 7, D6 additive). Never a wildcard; fails the process start closed
  // if absent.
  portalOrigin: string
  // The 6d source-token-bucket seam (Task 12). Defaults to NoThrottle until
  // the real bucket lands; see throttle.ts.
  throttle: ThrottlePort
}

export const EDGE_DEPS = 'AUTH_EDGE_DEPS'

export const DEFAULT_AUTH_DATABASE_URL = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=auth'

// v1 fixed token/session lifetimes (spec 04, mirrored by every login.ts test
// in services/auth). Not sourced from env: these are protocol constants, not
// per-deploy config, so there is no env-derived value to drift from the
// service's own assumptions.
const ACCESS_TTL_SEC = 600
const IDLE_SEC = 1800
const ABSOLUTE_SEC = 28800

// 6d source-throttle defaults (spec 12 task 12). A per-source token bucket:
// ~10 tokens absorbs a legitimate retype/refresh burst from one IP, while
// ~0.5 tokens/sec (one every two seconds) sustains a real user yet starves an
// automated password-spray. Plain numeric config (no secret), env-overridable
// per deploy. The key is the SOURCE IP, never the credential, so this never
// locks out a principal.
const THROTTLE_CAPACITY = 10
const THROTTLE_REFILL_PER_SEC = 0.5

function readPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number when set (6d throttle config, spec 12 task 12)`)
  }
  return parsed
}

// The real bootstrap's deps (main.ts only; never exercised by a test, which
// builds its own AuthEdgeDeps via test/helpers.ts with a jose-generated
// signer and test-scoped clients). The issuer, portal origin, and signer
// identity are never defaulted in code (S4): each is required and fails the
// process start closed if absent.
//
// The real AWS KMS signing adapter and the real Secrets Manager custody
// adapter are both deploy-time concerns (kms-signing.ts's own doc comment;
// no such adapter exists anywhere in this repo). Until they land, this
// builder wires the same LocalEs256Adapter and an in-process Map every test
// uses: the private key is generated fresh at process start (never baked into
// code) and the vault never leaves process memory. This is a known scaffold
// limitation, not a silent regression: a process restart mints a new signing
// key, so tokens issued before a restart stop verifying after one, and the
// custody vault does not survive a restart or span replicas. Both close when
// the deploy-time adapters land.
export async function buildAuthEdgeDepsFromEnv(): Promise<AuthEdgeDeps> {
  const signingKid = process.env.AUTH_EDGE_SIGNING_KID
  if (!signingKid) {
    throw new Error('AUTH_EDGE_SIGNING_KID is required (the signer identity is never defaulted in code, S4)')
  }
  const expectedIss = process.env.AUTH_EDGE_ISS
  if (!expectedIss) {
    throw new Error('AUTH_EDGE_ISS is required (the pinned issuer is never defaulted in code, D3/S10)')
  }
  const portalOrigin = process.env.AUTH_PORTAL_ORIGIN
  if (!portalOrigin) {
    throw new Error('AUTH_PORTAL_ORIGIN is required (the CORS allow-listed origin is never defaulted in code, spec 12 task 7)')
  }
  // The auth plane is LIVE-ONLY in v1 (S16, mirrors ops-edge/tenant-edge): a
  // future test plane is a config flip, not a retrofit.
  const expectedMode: Mode = 'live'
  const authUrl = process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL
  const totpIssuer = process.env.AUTH_TOTP_ISSUER ?? 'AndPayments'

  const signer = await LocalEs256Adapter.create(signingKid)
  const jwks = await signer.jwks()

  // The custody vault: an in-process Map, scaffold-only (see the doc comment
  // above). storeSecret and mfaSecretResolver share this ONE map so a secret
  // enrolled via this process is resolvable at login in the SAME process.
  const vault = new Map<string, string>()
  const storeSecret = async (principalId: string, secret: string): Promise<string> => {
    const ref = `vault://${principalId}`
    vault.set(ref, secret)
    return ref
  }
  const mfaSecretResolver = async (principalId: string): Promise<string | undefined> => vault.get(`vault://${principalId}`)

  return {
    authDb: new AuthClient({ datasourceUrl: authUrl }),
    signer,
    jwks,
    mfa: new TotpAdapter(),
    mfaSecretResolver,
    storeSecret,
    expectedIss,
    expectedMode,
    roleConfig: loadConfig(),
    accessTtlSec: ACCESS_TTL_SEC,
    idleSec: IDLE_SEC,
    absoluteSec: ABSOLUTE_SEC,
    totpIssuer,
    portalOrigin,
    // The deployed edge is throttled by default (6d): a per-source token
    // bucket, in-process (scaffold-only, like the vault above; a shared store
    // is a deploy-time swap behind the same ThrottlePort). It fails OPEN in the
    // login controller on its own failure, so auth still serves.
    throttle: new InMemoryTokenBucket({
      capacity: readPositiveNumber('AUTH_THROTTLE_CAPACITY', THROTTLE_CAPACITY),
      refillPerSec: readPositiveNumber('AUTH_THROTTLE_REFILL_PER_SEC', THROTTLE_REFILL_PER_SEC),
    }),
  }
}
