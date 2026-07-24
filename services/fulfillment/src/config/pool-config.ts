// Batching config-as-code (S23, spec 07 Field 5). Lot-size/max-wait knobs live
// here, never in a DB table, so a per-tenant or per-program override is a
// reviewed, CODEOWNERS-gated code change, not an unaudited runtime write. The
// OVERRIDES and TENANT_DEFAULTS maps are empty in v1: every pool runs on
// DEFAULT until a future change adds a specific entry.

export interface PoolCfg {
  minLotSize: number
  maxWaitSeconds: number
}

const DEFAULT: PoolCfg = { minLotSize: 50, maxWaitSeconds: 7 * 24 * 3600 }

// Per-(tenant, program) overrides, keyed by `${tenantWireId}|${programWireId}`.
// Empty in v1 (DEFAULT applies to every pool).
const OVERRIDES: Record<string, PoolCfg> = {}

// Per-tenant default, keyed by tenantWireId, applied when no more specific
// OVERRIDES entry exists for the (tenant, program) pair. Empty in v1.
const TENANT_DEFAULTS: Record<string, PoolCfg> = {}

/**
 * The batching config for one (tenant, program) pool. Precedence: the
 * (tenant, program) OVERRIDES entry, then the tenant's TENANT_DEFAULTS entry,
 * then DEFAULT.
 */
export function poolConfig(tenantWire: string, programWire: string): PoolCfg {
  return OVERRIDES[`${tenantWire}|${programWire}`] ?? TENANT_DEFAULTS[tenantWire] ?? DEFAULT
}
