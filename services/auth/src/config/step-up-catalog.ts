import type { StepUpEntry } from '@andpay/authz'

// StepUpEntry is single-sourced in @andpay/authz (T2, DD2); re-exported here so
// any Auth module importing the type from this path keeps working unchanged.
export type { StepUpEntry }

// The soundbox step-up catalog subset (6b): only the entries this slice needs,
// class-6 vendor-credential creation and MFA enrollment/reset. Versioned
// CI/CODEOWNERS config, no runtime control plane (S23). Full catalog breadth
// (payouts, bank-account change, posture loosening) is deferred.
export const STEP_UP_CATALOG: Record<string, StepUpEntry> = {
  'vendor_credential:create': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
  'mfa:enroll': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
  'mfa:reset': { minAcr: 'AAL2', freshnessSec: 300, escalates6c: false },
}
