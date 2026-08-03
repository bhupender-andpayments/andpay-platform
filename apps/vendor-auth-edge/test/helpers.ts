import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import type { JSONWebKeySet } from 'jose'
import {
  PrismaClient as AuthClient,
  type AuthDb,
  LocalEs256Adapter,
  TotpAdapter,
  enrollTotp,
  provisionVendorOperator,
  issueAccessToken,
  loadConfig,
  INTERNAL_ADMIN_PLANE,
  VENDOR_PLANE,
} from '@andpay/auth-service'
import { buildVendorAuthEdgeApp } from '../src/app.module.js'
import { type VendorAuthEdgeDeps, DEFAULT_AUTH_DATABASE_URL } from '../src/deps.js'
import { NoThrottle } from '../src/throttle.js'

// The shared fixture surface for every vendor-auth-edge test (spec 14a task
// 8 onward). Mirrors apps/auth-edge/test/helpers.ts, adapted for the class-7
// vendor audience and the Fork D multi-key signer.
export const EXPECTED_ISS = 'https://auth.andpay.test'

const authUrl = process.env.AUTH_DATABASE_URL ?? DEFAULT_AUTH_DATABASE_URL

// The ONE auth-context Prisma client every helper function in this file
// shares. Real DB, real schema (auth), pinned via AUTH_DATABASE_URL exactly
// like every services/auth test.
// Exported (additive) so a later test (e.g. refresh-logout.test.ts's
// disjointness proof) can seed a same-principalId internal refresh family
// directly, without a second Prisma client instance.
export const authDb: AuthDb = new AuthClient({ datasourceUrl: authUrl })

// The ONE multi-key signer every call to `buildTestVendorAuthEdgeApp` uses by
// default (mint and verify share one keypair PAIR: the returned `jwks` is
// always `await signer.jwks()`, aggregating BOTH the internal-admin and
// vendor public keys per Fork D). Lazily created once per test-file module
// instance (vitest gives each test file its own module graph, so this never
// leaks across files) and cached so `testJwks()` and
// `buildTestVendorAuthEdgeApp()` never disagree with each other, even across
// multiple calls in the same file.
let signerPromise: ReturnType<typeof buildMultiSigner> | undefined
async function buildMultiSigner() {
  const internalAdapter = await LocalEs256Adapter.create('vendor-test-internal-1')
  const vendorAdapter = await LocalEs256Adapter.create('vendor-test-vendor-1')
  return LocalEs256Adapter.createMulti({
    [INTERNAL_ADMIN_PLANE]: internalAdapter,
    [VENDOR_PLANE]: vendorAdapter,
  })
}
function sharedSigner() {
  if (!signerPromise) signerPromise = buildMultiSigner()
  return signerPromise
}

// The public verify keyset for the shared signer (both audiences' public
// keys, per Fork D). Exported standalone so a future test can mint its OWN
// raw JWT while still verifying against the exact keyset the app under test
// holds.
export async function testJwks(): Promise<JSONWebKeySet> {
  const signer = await sharedSigner()
  return signer.jwks()
}

// The shared in-memory custody vault: BOTH `storeSecret` (the enroll-side
// custody sink) and `mfaSecretResolver` (the login-side lookup) read/write
// this ONE map by default, so a secret enrolled via
// `seedVendorOperatorWithTotp` is resolvable at login through the SAME app
// instance. Keyed by (principalId, principalType), the carry-forward-3
// resolver shape (never principalId-only), so a vendor_operator secret never
// collides with an internal principal sharing the same id value. Module-
// scoped so every deps object this file builds (unless an override replaces
// storeSecret/mfaSecretResolver) shares it.
const vault = new Map<string, string>()

async function defaultStoreSecret(principalId: string, secret: string, principalType = 'vendor_operator'): Promise<string> {
  const ref = `vault://${principalType}/${principalId}`
  vault.set(ref, secret)
  return ref
}

async function defaultMfaSecretResolver(principalId: string, principalType: 'vendor_operator'): Promise<string | undefined> {
  return vault.get(`vault://${principalType}/${principalId}`)
}

// Builds a full `VendorAuthEdgeDeps` and the real Nest app (already
// `.init()`'d), ready to drive via `request(app.getHttpServer())`.
// `overrides` shallow-merges onto the default deps, so a later task can swap
// one field without rebuilding this whole helper.
export async function buildTestVendorAuthEdgeApp(overrides: Partial<VendorAuthEdgeDeps> = {}): Promise<INestApplication> {
  const signer = await sharedSigner()
  const jwks = await signer.jwks()

  const deps: VendorAuthEdgeDeps = {
    authDb,
    signer,
    jwks,
    mfa: new TotpAdapter(),
    mfaSecretResolver: defaultMfaSecretResolver,
    storeSecret: defaultStoreSecret,
    expectedIss: EXPECTED_ISS,
    expectedMode: 'live',
    roleConfig: loadConfig(),
    accessTtlSec: 600,
    idleSec: 1800,
    absoluteSec: 28800,
    totpIssuer: 'AndPayments Vendor Test',
    vendorPortalOrigin: 'https://vendor.andpay.test',
    throttle: NoThrottle,
    ...overrides,
  }

  const app = await buildVendorAuthEdgeApp(deps)
  await app.init()
  return app
}

export interface SeededVendorOperator {
  id: string
  vndrId: string
  username: string
  secret: string
}

// The known plaintext password every `seedVendorOperatorWithTotp` row is
// hashed from (exported so Tasks 9 to 12's login tests can drive a real
// login without re-deriving this constant).
export const SEEDED_VENDOR_PASSWORD = 'correct horse battery staple'

// Creates a real `vendor_operator` row (via the REAL `provisionVendorOperator`
// primitive, a known Argon2id-hashed password, ACTIVE) and enrolls a TOTP
// factor via the REAL `enrollTotp` (principalType:'vendor_operator') against
// the SAME vault this file's `mfaSecretResolver` reads (`defaultStoreSecret`),
// so the returned secret is immediately usable to drive a real AAL2 vendor
// login through an app built by `buildTestVendorAuthEdgeApp()`. The base32
// secret is recovered from the enroll otpauth:// URI (the only place it is
// ever exposed in plaintext), mirroring apps/auth-edge's
// seedPrincipalWithTotp.
export async function seedVendorOperatorWithTotp(vndrId: string, username: string): Promise<SeededVendorOperator> {
  const traceId = randomUUID()
  const { id } = await provisionVendorOperator(authDb, {
    vndrId,
    username,
    password: SEEDED_VENDOR_PASSWORD,
    createdByActor: randomUUID(),
    traceId,
  })

  const { otpauthUri } = await enrollTotp(authDb, {
    targetPrincipalId: id,
    targetAccountLabel: username,
    enrolledByActor: randomUUID(),
    issuer: 'AndPayments Vendor Test',
    storeSecret: defaultStoreSecret,
    principalType: 'vendor_operator',
    traceId: randomUUID(),
  })

  return { id, vndrId, username, secret: extractSecret(otpauthUri) }
}

// Mints a real class-3 internal-admin token off the SAME shared multi-key
// signer `buildTestVendorAuthEdgeApp` wires (Fork D): the internal-admin
// public key lives in the same JWKS this edge's admin guard verifies
// against, so a token minted here is accepted by a real app instance built
// via this file, exactly as if apps/auth-edge (a distinct process in a real
// deploy sharing the same KMS key, per deps.ts's scaffold-limitation
// comment) had minted it. Spec 14a task 11.
export async function mintAdminToken(principalId: string = randomUUID()): Promise<string> {
  const signer = await sharedSigner()
  return issueAccessToken(
    {
      principalId,
      cls: 3,
      mode: 'live',
      scope: {},
      psr: 'role:admin',
      epoch: 1,
      aud: INTERNAL_ADMIN_PLANE,
    },
    { signer, iss: EXPECTED_ISS, ttlSec: 600 },
  )
}

function extractSecret(otpauthUri: string): string {
  const match = /[?&]secret=([^&]+)/.exec(otpauthUri)
  const raw = match?.[1]
  if (!raw) throw new Error('otpauth uri missing the secret parameter')
  return decodeURIComponent(raw)
}
