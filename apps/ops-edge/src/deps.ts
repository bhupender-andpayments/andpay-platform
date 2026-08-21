import {
  PrismaClient as FulfillmentClient,
  type FulfillmentDb,
  loadOpsConfig,
  type AssetStore,
  FilesystemAssetStore,
  createS3AssetStore,
} from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient, type TmsDb } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient, type AnalyticsDb } from '@andpay/analytics-service'
import { PrismaClient as IdentityClient, type IdentityDb } from '@andpay/identity-service'
import type { Mode, RoleConfig } from '@andpay/authz'
import type { JSONWebKeySet } from 'jose'

// Token-provided deps (NO type-reflection DI: esbuild drops emitDecoratorMetadata
// under vitest, so every injectable here reads its deps off one explicit token,
// exactly the pattern the viability spike proved, mirroring the tenant edge).
// The guard and every Part-B controller are @Inject(EDGE_DEPS).
export interface OpsEdgeDeps {
  // The tms context DB. Wired here so it is injected once at process start,
  // never opened per request.
  tmsDb: TmsDb
  // The fulfillment context DB. Used HERE for the authz-audit outbox (the 6e
  // authn-DENY fact commits into fulfillment's own outbox so the existing
  // consumer drains it, ZERO new consumer wiring); Part-B ops actions use it too.
  fulfillmentDb: FulfillmentDb
  // The identity context DB (Phase 3 Task 7, ADDITIVE). Used by the Bank Master
  // admin routes to call identity's own createBankMaster/editBankMaster/
  // listBankMasters in-process; the identity function uses THIS db, so the edge
  // never does a cross-context DB write (C4). Injected once at process start,
  // never opened per request.
  identityDb: IdentityDb
  // The analytics context DB (spec 11 task 8, ADDITIVE). Used by the class-3
  // reporting routes to fan in-process to the analytics mediation API and to
  // emit BOTH the per-read analytics 6e AND the D99 cross-tenant-access entry
  // (guardrail G3) into the ANALYTICS outbox (never the fulfillment outbox).
  // Injected once at process start, never opened per request. The ops reporting
  // plane always constructs a { kind: 'crossTenant' } ReadScope by construction.
  analyticsDb: AnalyticsDb
  // The LOCAL public JWKS for the human plane (D3). The verifier holds only
  // public keys, never the signing key, and is injected once at process start,
  // never fetched per request (T4/S14/5e: zero call to Auth on the hot path).
  jwks: JSONWebKeySet
  // The issuer this edge pins (D3/S10 RFC 8725 hardening).
  expectedIss: string
  // The live/test plane this edge serves (S16), ANDed with the audience at
  // verification. A token whose mode claim differs is rejected (check 4).
  expectedMode: Mode
  // The class-3 ops role config (S15, D2, 4c), resolved LOCALLY at the edge
  // (T4). Part A wires it into deps only; Part B's authorize() calls consume it.
  roleConfig: RoleConfig
  // The single allow-listed browser origin for the ops portal (spec 12 task 7,
  // D6 additive). Never a wildcard; fails the process start closed if absent.
  portalOrigin: string
  // Phase 3 Task 5b: the T3 binary-asset storage port, injected once at
  // process start (the bank/branch logo upload route calls it in-process).
  // The DEV adapter (FilesystemAssetStore) is the default everywhere today.
  // It is filesystem-backed rather than in-memory for a specific reason: the
  // collateral this edge SERVES is rendered by the fulfillment consumer, a
  // DIFFERENT process, so a per-process store cannot resolve it. A future AWS
  // S3 adapter is a one-line change at the injection site, not a code change
  // in the controller or the domain op.
  assetStore: AssetStore
}

export const EDGE_DEPS = 'OPS_EDGE_DEPS'

// The multipart file size cap for the bank/damage upload routes
// (authenticated-DoS guard, mirroring vendor-edge's MAX_SHEET_BYTES): without a
// limit, multer buffers an arbitrarily large "file" part fully into memory
// before the handler runs. 5 MB matches the cap the ops portal already
// enforces client-side today (apps/ops-portal parseSheet.ts MAX_UPLOAD_BYTES).
// An oversized part is aborted by multer (MulterError LIMIT_FILE_SIZE), which
// NestJS's default FileInterceptor maps to a 413 PayloadTooLargeException, so no
// extra exception filter is needed.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

// The multipart file size cap for the aggregator logo upload route
// (authenticated-DoS guard). Bank .ai frame masters are vector artwork averaging
// 9MB and peaking at 22MB in the real GSCB set, so the 5MB sheet cap cannot
// serve this route. 32MB keeps a hard bound (the DoS guard survives, just sized
// for artwork) and applies ONLY to the aggregator logo route, never the sheet
// uploads.
export const MAX_ARTWORK_UPLOAD_BYTES = 32 * 1024 * 1024

export const DEFAULT_FULFILLMENT_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
export const DEFAULT_TMS_DATABASE_URL = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
export const DEFAULT_ANALYTICS_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
export const DEFAULT_IDENTITY_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=identity'

// The real bootstrap's deps (main.ts only; never exercised by a test, which
// builds its own OpsEdgeDeps with a jose-generated JWKS and test-scoped
// clients). Every input is required and fails the process start closed if
// absent (S4): the JWKS, issuer, and mode are never defaulted to a baked-in value.

// Choose the AssetStore adapter from the environment. ANDPAY_S3_BUCKET set means
// the S3 adapter (E-5); unset means the filesystem adapter, so local docker and
// CI behave exactly as before and no test needs credentials.
//
// The environment prefix is REQUIRED whenever the bucket is: one bucket holds
// more than one environment's assets, the logical key is a bank code that says
// nothing about which dataset wrote it, and two environments sharing a prefix
// interleave their version histories. That already happened once with the
// filesystem adapter's single temp-directory root, so this fails the process
// start closed rather than silently colliding.
//
// Credentials are never read here. The SDK's default chain (environment, then
// the shared profile) resolves them, which is what lets a local access key and
// a deployed instance role work without a code change (S4).
async function resolveAssetStore(): Promise<AssetStore> {
  const bucket = process.env.ANDPAY_S3_BUCKET
  if (bucket === undefined || bucket.trim() === '') return new FilesystemAssetStore()
  const prefix = process.env.ANDPAY_S3_PREFIX
  if (prefix === undefined || prefix.trim() === '') {
    throw new Error(
      'ANDPAY_S3_BUCKET is set but ANDPAY_S3_PREFIX is not. The prefix namespaces one environment inside the bucket; without it two environments overwrite each other version history.',
    )
  }
  return createS3AssetStore({
    bucket: bucket.trim(),
    prefix: prefix.trim(),
    // India only (S6). Defaulted rather than required so a local run needs one
    // variable, not three.
    region: process.env.AWS_REGION ?? 'ap-south-1',
  })
}

export async function buildOpsEdgeDepsFromEnv(): Promise<OpsEdgeDeps> {
  const rawJwks = process.env.OPS_EDGE_JWKS
  if (!rawJwks) {
    throw new Error('OPS_EDGE_JWKS is required (the human-plane public JWKS is never defaulted in code, S4)')
  }
  const expectedIss = process.env.OPS_EDGE_ISS
  if (!expectedIss) {
    throw new Error('OPS_EDGE_ISS is required (the pinned issuer is never defaulted in code, D3/S10)')
  }
  const portalOrigin = process.env.OPS_PORTAL_ORIGIN
  if (!portalOrigin) {
    throw new Error('OPS_PORTAL_ORIGIN is required (the CORS allow-listed origin is never defaulted in code, spec 12 task 7)')
  }
  // The ops plane is LIVE-ONLY in v1 (S16/Fork D, mirrors the tenant edge): a
  // future test plane is a config flip, not a retrofit, so this is not read
  // from an env toggle. An env-derived mode would fail closed toward 'test' on
  // an unset/mistyped var, backwards from live-only (accepting a
  // lower-assurance mode:test token).
  const expectedMode: Mode = 'live'
  const fulfillmentUrl = process.env.FULFILLMENT_DATABASE_URL ?? DEFAULT_FULFILLMENT_DATABASE_URL
  const tmsUrl = process.env.TMS_DATABASE_URL ?? DEFAULT_TMS_DATABASE_URL
  const analyticsUrl = process.env.ANALYTICS_DATABASE_URL ?? DEFAULT_ANALYTICS_DATABASE_URL
  const identityUrl = process.env.IDENTITY_DATABASE_URL ?? DEFAULT_IDENTITY_DATABASE_URL

  const jwks = JSON.parse(rawJwks) as JSONWebKeySet
  return {
    tmsDb: new TmsClient({ datasourceUrl: tmsUrl }),
    fulfillmentDb: new FulfillmentClient({ datasourceUrl: fulfillmentUrl }),
    analyticsDb: new AnalyticsClient({ datasourceUrl: analyticsUrl }),
    identityDb: new IdentityClient({ datasourceUrl: identityUrl }),
    jwks,
    expectedIss,
    expectedMode,
    roleConfig: loadOpsConfig(),
    portalOrigin,
    // Filesystem-backed by default so the edge can serve collateral rendered
    // by the fulfillment CONSUMER, a different process. Set ANDPAY_S3_BUCKET
    // (plus ANDPAY_S3_PREFIX) to use the S3 adapter instead: E-5.
    assetStore: await resolveAssetStore(),
  }
}
