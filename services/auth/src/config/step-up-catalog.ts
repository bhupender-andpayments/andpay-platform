import type { Acr } from '@andpay/authz'

export interface StepUpEntry {
  // Minimum acr the fresh proof must reach (6a).
  minAcr: Acr
  // Freshness window in seconds against auth_time, NOT iat (6b).
  freshnessSec: number
  // Whether the operation escalates to a 6c dual-control ceremony (none in this
  // slice; the full control matrix is deferred).
  escalates6c: boolean
}

// The soundbox step-up catalog subset (6b): only the entries this slice needs,
// class-6 vendor-credential creation and MFA enrollment/reset. Versioned
// CI/CODEOWNERS config, no runtime control plane (S23). Full catalog breadth
// (payouts, bank-account change, posture loosening) is deferred.
export const STEP_UP_CATALOG: Record<string, StepUpEntry> = {
  'vendor_credential:create': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
  'mfa:enroll': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
  'mfa:reset': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
}
