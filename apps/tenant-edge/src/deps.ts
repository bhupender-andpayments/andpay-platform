import { PrismaClient as FulfillmentClient, type FulfillmentDb } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient, type TmsDb } from '@andpay/tms-service'
import type { Mode } from '@andpay/authz'
import type { JSONWebKeySet } from 'jose'

// Token-provided deps (NO type-reflection DI: esbuild drops emitDecoratorMetadata
// under vitest, so every injectable here reads its deps off one explicit token,
// exactly the pattern the viability spike proved). The guard and every Task-6
// controller are @Inject(EDGE_DEPS).
export interface TenantEdgeDeps {
  // The tenant read plane's own context DB (Task-6 controllers query it). Wired
  // here so it is injected once at process start, never opened per request.
  tmsDb: TmsDb
  // The fulfillment context DB. Used HERE only for the authz-audit outbox (the
  // 6e authn-DENY fact commits into fulfillment's own outbox so the existing
  // consumer drains it, ZERO new consumer wiring); Task-6 shipment reads use it too.
  fulfillmentDb: FulfillmentDb
  // The LOCAL public JWKS for the human plane (D3). The verifier holds only
  // public keys, never the signing key, and is injected once at process start,
  // never fetched per request (T4/S14/5e: zero call to Auth on the hot path).
  jwks: JSONWebKeySet
  // The issuer this edge pins (D3/S10 RFC 8725 hardening).
  expectedIss: string
  // The live/test plane this edge serves (S16), ANDed with the audience at
  // verification. A token whose mode claim differs is rejected (check 4).
  expectedMode: Mode
}

export const EDGE_DEPS = 'TENANT_EDGE_DEPS'

export const DEFAULT_FULFILLMENT_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
export const DEFAULT_TMS_DATABASE_URL = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'

// The real bootstrap's deps (main.ts only; never exercised by a test, which
// builds its own TenantEdgeDeps with a jose-generated JWKS and test-scoped
// clients). Every input is required and fails the process start closed if
// absent (S4): the JWKS, issuer, and mode are never defaulted to a baked-in value.
export function buildTenantEdgeDepsFromEnv(): TenantEdgeDeps {
  const rawJwks = process.env.TENANT_EDGE_JWKS
  if (!rawJwks) {
    throw new Error('TENANT_EDGE_JWKS is required (the human-plane public JWKS is never defaulted in code, S4)')
  }
  const expectedIss = process.env.TENANT_EDGE_ISS
  if (!expectedIss) {
    throw new Error('TENANT_EDGE_ISS is required (the pinned issuer is never defaulted in code, D3/S10)')
  }
  const expectedMode: Mode = process.env.TENANT_EDGE_MODE === 'live' ? 'live' : 'test'
  const fulfillmentUrl = process.env.FULFILLMENT_DATABASE_URL ?? DEFAULT_FULFILLMENT_DATABASE_URL
  const tmsUrl = process.env.TMS_DATABASE_URL ?? DEFAULT_TMS_DATABASE_URL

  const jwks = JSON.parse(rawJwks) as JSONWebKeySet
  return {
    tmsDb: new TmsClient({ datasourceUrl: tmsUrl }),
    fulfillmentDb: new FulfillmentClient({ datasourceUrl: fulfillmentUrl }),
    jwks,
    expectedIss,
    expectedMode,
  }
}
