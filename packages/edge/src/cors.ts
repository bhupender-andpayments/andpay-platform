export interface CorsOptions {
  origin: string[]
  credentials: boolean
  methods: string[]
  allowedHeaders: string[]
}

// A minimal structural shape for the one Nest application method this helper
// needs. Declared locally instead of importing the Nest application type so
// @andpay/edge stays framework-free (spec 10a REPO SHAPE guard,
// test/architecture.test.ts): any object exposing enableCors satisfies this,
// including a real Nest application instance, with zero Nest import here.
export interface CorsCapableApp {
  enableCors(options: CorsOptions): void
}

// Browser CORS for the human portals (spec 12 field 8 Fork A). Allow-lists the
// single configured portal origin (never a wildcard), credentialed so the
// auth-edge refresh cookie is accepted on its path, minimal methods/headers.
// This is additive middleware: it changes no handler behavior, only the
// preflight/response headers.
// Every write route on both portals REQUIRES an Idempotency-Key header (the
// 06.A key grammar), so omitting it from the allow-list made the browser refuse
// to send the actual request after a passing preflight: every upload and every
// write failed as an opaque "Failed to fetch". The jsdom page tests could not
// catch it because jsdom does not enforce CORS. The list must therefore stay in
// step with what the SPA api layer actually sets, which is exactly these three.
export function buildPortalCorsOptions(allowedOrigin: string): CorsOptions {
  return { origin: [allowedOrigin], credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['authorization', 'content-type', 'idempotency-key'] }
}

export function applyPortalCors(app: CorsCapableApp, allowedOrigin: string): void {
  app.enableCors(buildPortalCorsOptions(allowedOrigin))
}

// Browser CORS for a BEARER-ONLY edge (spec 14a task 15, check 6): an edge
// whose ONLY credential transport is the Authorization header, never a
// cookie, so Access-Control-Allow-Credentials must never be true on this
// path (a credentialed response is meaningless, and wrong, when no cookie is
// ever set or read here). Allow-lists the single configured origin (never a
// wildcard), same minimal methods/headers as the portal variant.
export function buildBearerCorsOptions(allowedOrigin: string): CorsOptions {
  return { origin: [allowedOrigin], credentials: false, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['authorization', 'content-type', 'idempotency-key'] }
}

export function applyBearerCors(app: CorsCapableApp, allowedOrigin: string): void {
  app.enableCors(buildBearerCorsOptions(allowedOrigin))
}
