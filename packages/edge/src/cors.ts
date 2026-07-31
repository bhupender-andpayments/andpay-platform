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
export function buildPortalCorsOptions(allowedOrigin: string): CorsOptions {
  return { origin: [allowedOrigin], credentials: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['authorization', 'content-type'] }
}

export function applyPortalCors(app: CorsCapableApp, allowedOrigin: string): void {
  app.enableCors(buildPortalCorsOptions(allowedOrigin))
}
