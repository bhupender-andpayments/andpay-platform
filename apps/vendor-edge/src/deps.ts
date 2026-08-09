import { PrismaClient as FulfillmentClient, FilesystemAssetStore, type FulfillmentDb, type AssetStore } from '@andpay/fulfillment-service'
import type { Mode } from '@andpay/authz'
import type { JSONWebKeySet } from 'jose'

// Token-provided deps (NO type-reflection DI: esbuild drops emitDecoratorMetadata
// under vitest, so every injectable here reads its deps off one explicit
// token, exactly the pattern the viability spike proved). The guard and all
// three controllers are @Inject(EDGE_DEPS).
export interface EdgeDeps {
  fulfillmentDb: FulfillmentDb
  // The 5c pepper (Buffer or string), injected at process start from the
  // pepper-custody port (Secrets Manager in production, an env var in local
  // dev/CI). NEVER hardcoded here (S4): a missing pepper fails the process
  // start closed, it is not defaulted to a baked-in value.
  pepper: Buffer | string
  expectedMode: Mode
  // Spec 14a task 13: the LOCAL public JWKS for the class-7 vendor-operator
  // plane (D3). The verifier holds only public keys, never the signing key,
  // injected once at process start (T4/S14/5e: zero call to Auth on the
  // request path). OPTIONAL, mirroring resolve.ts's own ResolveDeps: an edge
  // that wires neither jwks nor expectedIss serves class-6 apsk_ only, and any
  // JWT-shaped credential fails closed with 'jwt-not-supported-on-this-edge'
  // (byte-identical to the pre-task-13 behavior, D6). Both fields are wired
  // together in buildVendorEdgeDepsFromEnv's fail-closed real bootstrap.
  jwks?: JSONWebKeySet
  expectedIss?: string
  // The single allow-listed browser origin for the EXTERNAL vendor portal
  // (spec 14a task 15, check 6), the SAME origin vendor-auth-edge allow-lists
  // (deps.vendorPortalOrigin there). This edge is bearer-only (no cookie is
  // ever set or read here), so its CORS is applied WITHOUT credentials
  // (applyBearerCors, @andpay/edge), unlike vendor-auth-edge's credentialed
  // cookie path. Never a wildcard; fails the process start closed if absent
  // (buildEdgeDepsFromEnv).
  vendorPortalOrigin: string
  // Phase 4 (P4-D6): the binary-asset store used by the dispatch-package
  // per-type PDF pull (assembleTypePdf reads the stored collateral bytes).
  // Core infra like fulfillmentDb; the DEV adapter (FilesystemAssetStore) is the
  // default, an S3 adapter later (same seam as ops-edge).
  assetStore: AssetStore
}

export const EDGE_DEPS = 'EDGE_DEPS'

export const DEFAULT_FULFILLMENT_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'

// The multipart file size cap shared by /vendor/intake and /vendor/return
// (authenticated-DoS review fix): without a limit, multer buffers an
// arbitrarily large "file" part fully into memory before the handler ever
// sees it. 5 MiB is generous for a JSON vendor sheet; an oversized upload is
// aborted by multer (MulterError code LIMIT_FILE_SIZE), which NestJS's
// default FileInterceptor already maps to a 413 PayloadTooLargeException, so
// no additional exception filter is needed here.
export const MAX_SHEET_BYTES = 5 * 1024 * 1024

// The real bootstrap's deps (main.ts only; never exercised by a test, which
// builds its own EdgeDeps with a fixture pepper and a test-scoped FulfillmentClient).
export function buildEdgeDepsFromEnv(): EdgeDeps {
  const pepper = process.env.VENDOR_EDGE_PEPPER
  if (!pepper) {
    throw new Error('VENDOR_EDGE_PEPPER is required (the 5c pepper is never defaulted in code, S4)')
  }
  const rawJwks = process.env.VENDOR_EDGE_JWKS
  if (!rawJwks) {
    throw new Error('VENDOR_EDGE_JWKS is required (the class-7 vendor-operator public JWKS is never defaulted in code, S4)')
  }
  const expectedIss = process.env.VENDOR_EDGE_ISS
  if (!expectedIss) {
    throw new Error('VENDOR_EDGE_ISS is required (the pinned issuer is never defaulted in code, D3/S10)')
  }
  const vendorPortalOrigin = process.env.VENDOR_PORTAL_ORIGIN
  if (!vendorPortalOrigin) {
    throw new Error('VENDOR_PORTAL_ORIGIN is required (the CORS allow-listed origin is never defaulted in code, check 6)')
  }
  const datasourceUrl = process.env.FULFILLMENT_DATABASE_URL ?? DEFAULT_FULFILLMENT_DATABASE_URL
  const expectedMode: Mode = process.env.VENDOR_EDGE_MODE === 'live' ? 'live' : 'test'
  const jwks = JSON.parse(rawJwks) as JSONWebKeySet
  return {
    fulfillmentDb: new FulfillmentClient({ datasourceUrl }),
    pepper,
    expectedMode,
    jwks,
    expectedIss,
    vendorPortalOrigin,
    // Filesystem-backed: the collateral this edge serves to the print vendor
    // is rendered by the fulfillment CONSUMER, a different process, so a
    // per-process store cannot resolve it. E-5 (S3) is still open.
    assetStore: new FilesystemAssetStore(),
  }
}
