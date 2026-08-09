import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { afterAll } from 'vitest'
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
// custody sink) and `resolveSecretRef` (the verification-side lookup) read/write
// this ONE map by default, so a secret enrolled via
// `seedVendorOperatorWithTotp` is resolvable at login through the SAME app
// instance. Keyed by (principalId, principalType), the carry-forward-3
// resolver shape (never principalId-only), so a vendor_operator secret never
// collides with an internal principal sharing the same id value. Module-
// scoped so every deps object this file builds (unless an override replaces
// storeSecret/resolveSecretRef) shares it.
const vault = new Map<string, string>()

async function defaultStoreSecret(principalId: string, secret: string, principalType = 'vendor_operator'): Promise<string> {
  const ref = `vault://${principalType}/${principalId}/${randomUUID()}`
  vault.set(ref, secret)
  return ref
}

async function defaultResolveSecretRef(secretRef: string): Promise<string | undefined> {
  return vault.get(secretRef)
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
    resolveSecretRef: defaultResolveSecretRef,
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

// F-4, the vendor half. Same reasoning as apps/auth-edge/test/helpers.ts: the
// F-9c global teardown refuses to touch `auth`, so this residue class has to be
// cleaned at the one place that mints it. Measured 2026-08-09, a single run of
// the two auth edge suites left 15 vendor_operator rows behind.
//
// These rows matter more than their count suggests: a leftover vendor_operator
// is indistinguishable at a glance from a real one, which is the same reason
// the leaked `wq-map-a`/`wq-map-b` credential rows were worth fixing in F-9b.
//
// Scoped by the ids we actually created, never by a username pattern.
const seededVendorOperatorIds: string[] = []

// Operators this file created by driving the REAL provision ROUTE over HTTP
// rather than by calling the helper. Those rows are minted server-side, so the
// helper never sees their ids and they leaked straight past the tracking above
// (measured: 5 such call sites, and they are why the first cleanup still left
// 2 rows per run behind). Registering the username is the whole contract; the
// id is resolved at cleanup time.
const provisionedUsernames: string[] = []

/**
 * Register a username that a test is about to provision THROUGH THE ROUTE, so
 * it is cleaned up with everything else this file created (F-4).
 *
 * Call it for any operator not created via `seedVendorOperatorWithTotp`.
 * Deliberately explicit rather than a `DELETE ... WHERE username LIKE 'op-%'`
 * sweep: a pattern delete is only safe while no real vendor_operator row
 * happens to match, which is an assumption about data rather than a property
 * of the code, and the bare TRUNCATE that used to live in these suites is the
 * cautionary tale.
 */
export function trackProvisionedOperator(username: string): string {
  provisionedUsernames.push(username)
  return username
}

afterAll(async () => {
  if (provisionedUsernames.length > 0) {
    const usernames = provisionedUsernames.splice(0)
    try {
      const rows = await authDb.vendorOperator.findMany({ where: { username: { in: usernames } }, select: { id: true } })
      seededVendorOperatorIds.push(...rows.map((r) => r.id))
    } catch (e) {
      console.warn(`[vendor-auth-edge cleanup] failed to resolve ${usernames.length} provisioned operators:`, e)
    }
  }
  if (seededVendorOperatorIds.length === 0) return
  const ids = seededVendorOperatorIds.splice(0)
  try {
    // Children first: the auth schema declares no foreign keys, so nothing
    // cascades.
    //
    // NOT filtered by principalType, and that is deliberate rather than an
    // oversight. The two principal kinds share both child tables and are told
    // apart by that discriminator, so filtering looks like the careful choice.
    // It is not, because what we own here is the ID: we minted it, so every
    // row keyed to it is this file's residue whatever plane it claims.
    //
    // `refresh-logout.test.ts` proves the difference is real rather than
    // theoretical. Its disjointness test deliberately seeds an INTERNAL-plane
    // refresh family under a VENDOR operator's id, to show the vendor plane
    // never touches it. A principalType-filtered delete leaves exactly those
    // rows behind, which is measurable: it was the last 2 rows per run still
    // leaking after everything else was fixed.
    await authDb.mfaEnrollment.deleteMany({ where: { principalId: { in: ids } } })
    await authDb.refreshToken.deleteMany({ where: { principalId: { in: ids } } })
    await authDb.vendorOperator.deleteMany({ where: { id: { in: ids } } })
  } catch (e) {
    console.warn(`[vendor-auth-edge cleanup] failed to remove ${ids.length} seeded operators:`, e)
  }
})

// Creates a real `vendor_operator` row (via the REAL `provisionVendorOperator`
// primitive, a known Argon2id-hashed password, ACTIVE) and enrolls a TOTP
// factor via the REAL `enrollTotp` (principalType:'vendor_operator') against
// the SAME vault this file's `resolveSecretRef` reads (`defaultStoreSecret`),
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
  seededVendorOperatorIds.push(id)

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
