import { PrismaClient as FulfillmentClient, type FulfillmentDb, loadOpsConfig } from '@andpay/fulfillment-service'
import { PrismaClient as TmsClient, type TmsDb } from '@andpay/tms-service'
import { PrismaClient as AnalyticsClient, type AnalyticsDb } from '@andpay/analytics-service'
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
}

export const EDGE_DEPS = 'OPS_EDGE_DEPS'

export const DEFAULT_FULFILLMENT_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
export const DEFAULT_TMS_DATABASE_URL = 'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
export const DEFAULT_ANALYTICS_DATABASE_URL =
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'

// The real bootstrap's deps (main.ts only; never exercised by a test, which
// builds its own OpsEdgeDeps with a jose-generated JWKS and test-scoped
// clients). Every input is required and fails the process start closed if
// absent (S4): the JWKS, issuer, and mode are never defaulted to a baked-in value.
export function buildOpsEdgeDepsFromEnv(): OpsEdgeDeps {
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

  const jwks = JSON.parse(rawJwks) as JSONWebKeySet
  return {
    tmsDb: new TmsClient({ datasourceUrl: tmsUrl }),
    fulfillmentDb: new FulfillmentClient({ datasourceUrl: fulfillmentUrl }),
    analyticsDb: new AnalyticsClient({ datasourceUrl: analyticsUrl }),
    jwks,
    expectedIss,
    expectedMode,
    roleConfig: loadOpsConfig(),
    portalOrigin,
  }
}
