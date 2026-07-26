import { PrismaClient as FulfillmentClient, type FulfillmentDb } from '@andpay/fulfillment-service'
import type { Mode } from '@andpay/authz'

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
  const datasourceUrl = process.env.FULFILLMENT_DATABASE_URL ?? DEFAULT_FULFILLMENT_DATABASE_URL
  const expectedMode: Mode = process.env.VENDOR_EDGE_MODE === 'live' ? 'live' : 'test'
  return {
    fulfillmentDb: new FulfillmentClient({ datasourceUrl }),
    pepper,
    expectedMode,
  }
}
