import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { afterAll } from 'vitest'
import { hash as argonHash } from '@node-rs/argon2'
import type { INestApplication } from '@nestjs/common'
import type { JSONWebKeySet } from 'jose'
import {
  PrismaClient as AuthClient,
  type AuthDb,
  LocalEs256Adapter,
  TotpAdapter,
  enrollTotp,
  loadConfig,
} from '@andpay/auth-service'
import { buildAuthEdgeApp } from '../src/app.module.js'
import { type AuthEdgeDeps, DEFAULT_AUTH_DATABASE_URL } from '../src/deps.js'
import { NoThrottle } from '../src/throttle.js'

// The shared fixture surface for every auth-edge test in Part C (spec 12
// tasks 8 to 13). This file is load-bearing: Tasks 9 to 12 build the login,
// refresh, logout, and enroll controllers directly against the deps this
// helper assembles, and drive them over real HTTP via
// `request(app.getHttpServer())`, exactly like the ops-edge/tenant-edge
// suites.
export const EXPECTED_ISS = 'https://auth.andpay.test'

const authUrl = process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL

// The ONE auth-context Prisma client every helper function in this file
// shares. Real DB, real schema (auth), pinned via AUTH_DATABASE_URL exactly
// like every services/auth test.
const authDb: AuthDb = new AuthClient({ datasourceUrl: authUrl })

// The ONE signer every call to `buildTestAuthEdgeApp` uses by default (mint
// and verify share one keypair: the returned `jwks` is always
// `await signer.jwks()`). Lazily created once per test-file module instance
// (vitest gives each test file its own module graph, so this never leaks
// across files) and cached so `testJwks()` and `buildTestAuthEdgeApp()` never
// disagree with each other, even across multiple calls in the same file.
let signerPromise: Promise<LocalEs256Adapter> | undefined
function sharedSigner(): Promise<LocalEs256Adapter> {
  if (!signerPromise) signerPromise = LocalEs256Adapter.create('test-1')
  return signerPromise
}

// The public verify keyset for the shared signer. Exported standalone so a
// test can mint its OWN raw JWT (a wrong-signer/wrong-alg/wrong-issuer/expired
// regression, see refresh-verify.test.ts, which mirrors the ops-edge/
// tenant-edge authn suites' mintWith pattern) while still verifying against
// the exact keyset the app under test holds.
export async function testJwks(): Promise<JSONWebKeySet> {
  const signer = await sharedSigner()
  return signer.jwks()
}

// Mints a raw access token with the SHARED SIGNER (the same key the app under
// test verifies against), for a regression that must isolate a SINGLE
// malformed dimension (e.g. expiry, issuer) while everything else about the
// token, including its signer and alg, stays correct. A wrong-signer or
// wrong-alg regression instead mints with its OWN separate keypair via jose's
// SignJWT directly (see refresh-verify.test.ts), exactly like ops-edge's
// mintWith.
export async function mintRawAccessToken(input: {
  claims: Record<string, unknown>
  iss?: string
  sub?: string
  aud?: string
  ttlSec: number
  now?: number
}): Promise<string> {
  const signer = await sharedSigner()
  return signer.sign({
    claims: input.claims,
    iss: input.iss ?? EXPECTED_ISS,
    sub: input.sub ?? randomUUID(),
    aud: input.aud ?? 'andpay:internal-admin',
    ttlSec: input.ttlSec,
    now: input.now,
  })
}

// The shared in-memory custody vault: BOTH `storeSecret` (the enroll-side
// custody sink) and `resolveSecretRef` (the verification-side lookup) read and
// write this ONE map by default, so a secret enrolled via
// `seedPrincipalWithTotp` is resolvable at login through the SAME app
// instance. Keyed by the REFERENCE storeSecret returns, mirroring production
// custody: one key per enrollment, never one per principal.
const vault = new Map<string, string>()

async function defaultStoreSecret(principalId: string, secret: string): Promise<string> {
  const ref = `vault://${principalId}/${randomUUID()}`
  vault.set(ref, secret)
  return ref
}

async function defaultResolveSecretRef(secretRef: string): Promise<string | undefined> {
  return vault.get(secretRef)
}

// Builds a full `AuthEdgeDeps` and the real Nest app (already `.init()`'d),
// ready to drive via `request(app.getHttpServer())`. `overrides` shallow-
// merges onto the default deps, so a later task (e.g. Task 12's real
// ThrottlePort) can swap one field without rebuilding this whole helper.
export async function buildTestAuthEdgeApp(overrides: Partial<AuthEdgeDeps> = {}): Promise<INestApplication> {
  const signer = await sharedSigner()
  const jwks = await signer.jwks()

  const deps: AuthEdgeDeps = {
    authDb,
    signer,
    jwks,
    mfa: new TotpAdapter(),
    resolveSecretRef: defaultResolveSecretRef,
    storeSecret: defaultStoreSecret,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
    roleConfig: loadConfig(),
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    totpIssuer: 'AndPayments Test',
    portalOrigin: 'https://login.andpay.test',
    throttle: NoThrottle,
    ...overrides,
  }

  const app = await buildAuthEdgeApp(deps)
  await app.init()
  return app
}

export interface SeededPrincipal {
  handle: string
  secret: string
  principalId: string
}

// The known plaintext password every `seedPrincipalWithTotp` row is hashed
// from (exported so Tasks 9 to 11's login tests can drive a real login
// without re-deriving this constant).
export const SEEDED_PASSWORD = 'correct horse battery staple'

// F-4: every principal this helper mints, so the hook below can delete exactly
// those rows and nothing else.
//
// WHY THIS IS THE RIGHT UNIT OF WORK. `auth` is the one schema the F-9c global
// teardown REFUSES to touch, and deliberately: it holds the demo login and the
// hash-chained audit ledger. So auth residue cannot be solved the way the four
// domain schemas were, and it had been growing unbounded (measured 2026-08-09:
// 2047 principals, 2238 MFA enrollments, 2412 refresh tokens, +21/+39/+52 from
// a SINGLE run of the two auth edge suites).
//
// Cleanup lives HERE, at the one place that mints them, rather than in each of
// the 8 suites that call it: this is the F-9c lesson (fix the choke point, not
// the instances) applied where a global teardown is not allowed to reach. Any
// FUTURE suite calling this helper is covered automatically, which is what
// stops the leak recurring.
//
// SCOPED BY ID, NEVER BY NAME. Deleting `login_handle LIKE 'test-%'` would work
// today and is exactly the kind of unfiltered-by-shape delete that has already
// bitten this repo once: the bare `TRUNCATE` these suites used to run took the
// demo login with it. Tracking the ids we actually created cannot touch
// `ops.admin`, and cannot touch `authz_audit`, which is HASH-CHAINED and must
// never have rows removed to tidy up.
const seededPrincipalIds: string[] = []

// vitest gives each test file its own module graph (see the `signerPromise`
// note above), so this array holds only the CURRENT file's principals and this
// hook registers once per file that imports the helper.
afterAll(async () => {
  if (seededPrincipalIds.length === 0) return
  const ids = seededPrincipalIds.splice(0)
  try {
    // Children first: the auth schema declares NO foreign keys at all, so
    // nothing cascades and an orphaned enrollment or refresh token would
    // simply be left behind. Keyed on the id alone, not on principalType:
    // what we own is the ID we minted, so every row under it is ours whatever
    // plane it claims (see the fuller note in vendor-auth-edge's helpers,
    // where a principalType filter demonstrably stranded rows).
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: ids } } })
    await authDb.refreshToken.deleteMany({ where: { principalId: { in: ids } } })
    await authDb.internalPrincipal.deleteMany({ where: { id: { in: ids } } })
  } catch (e) {
    // LOUD BUT NEVER FATAL, mirroring the global teardown: a green suite must
    // not turn red because tidying failed.
    console.warn(`[auth-edge cleanup] failed to remove ${ids.length} seeded principals:`, e)
  }
})

// Creates a real `internal_principal` row (a known Argon2id-hashed password,
// ACTIVE, a random loginHandle) and enrolls a TOTP factor via the REAL
// `enrollTotp` against the SAME vault this file's `resolveSecretRef` reads
// (`defaultStoreSecret`), so the returned secret is immediately usable to
// drive a real AAL2 login through an app built by `buildTestAuthEdgeApp()`.
// The base32 secret is recovered from the enroll otpauth:// URI (the only
// place it is ever exposed in plaintext, mirroring services/auth's own
// enroll.test.ts).
export async function seedPrincipalWithTotp(role: string): Promise<SeededPrincipal> {
  const principalId = randomUUID()
  const handle = `test-${role}-${principalId.slice(0, 8)}`
  seededPrincipalIds.push(principalId)

  await authDb.internalPrincipal.create({
    data: {
      id: principalId,
      loginHandle: handle,
      passwordHash: await argonHash(SEEDED_PASSWORD),
      status: 'ACTIVE',
      role,
    },
  })

  const { otpauthUri } = await enrollTotp(authDb, {
    targetPrincipalId: principalId,
    targetAccountLabel: handle,
    enrolledByActor: randomUUID(),
    issuer: 'AndPayments Test',
    storeSecret: defaultStoreSecret,
    traceId: randomUUID(),
  })

  return { handle, secret: extractSecret(otpauthUri), principalId }
}

function extractSecret(otpauthUri: string): string {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri)
  const raw = match?.[1]
  if (!raw) throw new Error('otpauth uri missing the secret parameter')
  return decodeURIComponent(raw)
}
