import type { LeanClaim, Acr } from './claims.js'
import { AuthzError } from './errors.js'
import { meetsAcr } from './assurance.js'
import { type OpsStepUpKey } from './stepup-operations.js'

export interface StepUpEntry {
  minAcr: Acr
  freshnessSec: number
  escalates6c: boolean
}

// Step-up gate (6b/S15): a high-risk action requires a minimum acr AND freshness
// against auth_time (NOT iat). Edge-local so the ops edge never calls Auth (T4).
export function requireStepUp(claim: LeanClaim, entry: StepUpEntry, now: number): void {
  if (claim.acr === undefined || !meetsAcr(claim.acr, entry.minAcr)) {
    throw new AuthzError('step-up-required', `needs ${entry.minAcr}`)
  }
  const authTime = claim.auth_time ?? 0
  if (now - authTime > entry.freshnessSec) {
    throw new AuthzError('step-up-required', 'stale-auth-time')
  }
}

// The known step-up catalog keys (Fix wave 1, Minor 4). Named so
// OPS_STEP_UP_CATALOG can be typed `Partial<Record<OpsStepUpKey, StepUpEntry>>`
// instead of a bare `Record<string, StepUpEntry>`: the latter's index signature
// would make `keyof typeof OPS_STEP_UP_CATALOG` widen to plain `string`, which
// defeats the point (a typo'd key at a call site would type-check). With the
// literal keys preserved and the values kept optional, `keyof typeof
// OPS_STEP_UP_CATALOG` is exactly this union (a typo is a compile error at the
// call site), while indexing still yields `StepUpEntry | undefined` (so the
// caller's defensive `entry === undefined` runtime guard still type-checks,
// for a future catalog entry removed out from under a still-referencing key).
// The union itself is derived from stepup-operations.ts (single source, no drift).

// Soundbox ops step-up catalog (S15/6b), config-as-code, CODEOWNERS-gated (S23).
// Tier 1 single-actor step-up to AAL2-freshness for the three destructive ops
// actions. NOT Tier 3 dual-control (S15 reserves that for funds-adjacent scope;
// ops moves no money). AAL3 factor wiring is deploy-deferred (spec 04), so an
// AAL3 entry (none here) would gate closed.
export const OPS_STEP_UP_CATALOG: Partial<Record<OpsStepUpKey, StepUpEntry>> = {
  'terminal-override': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
  'hold-release': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
  'vendor-suspend': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
}
