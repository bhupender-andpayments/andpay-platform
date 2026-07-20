import { AuthzError, type LeanClaim } from '@andpay/authz'
import { meetsAcr } from './assurance.js'
import type { StepUpEntry } from './config/step-up-catalog.js'

// Step-up gate (6b): a high-risk operation requires a minimum acr AND freshness
// against auth_time (NOT iat, so a routine refresh does not falsely reset
// freshness). Insufficient acr or a stale auth_time denies with a
// step-up-required signal; the client re-authenticates with its enrolled MFA
// factor to mint a fresh claim, then retries.
export function requireStepUp(claim: LeanClaim, entry: StepUpEntry, now: number): void {
  if (claim.acr === undefined || !meetsAcr(claim.acr, entry.minAcr)) {
    throw new AuthzError('step-up-required', `needs ${entry.minAcr}`)
  }
  const authTime = claim.auth_time ?? 0
  if (now - authTime > entry.freshnessSec) {
    throw new AuthzError('step-up-required', 'stale-auth-time')
  }
}
