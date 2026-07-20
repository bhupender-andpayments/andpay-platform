import { AuthzError, type Acr, type Amr } from '@andpay/authz'

const RANK: Record<Acr, number> = { AAL1: 1, AAL2: 2, AAL3: 3 }

// Achieved assurance from the factors presented at authentication (6a): a
// password alone is AAL1; a password plus a second factor (TOTP) is AAL2; a
// hardware phishing-resistant factor (WebAuthn) reaches AAL3. WebAuthn is
// deferred in this slice, so amr never carries hwk in v1 and AAL3 is
// structurally unreachable (which gates super_admin login closed).
export function computeAcr(amr: Amr[]): Acr {
  if (amr.includes('hwk')) return 'AAL3'
  const hasPwd = amr.includes('pwd')
  const hasSecond = amr.some((m) => m === 'otp' || m === 'sms' || m === 'swk')
  if (hasPwd && hasSecond) return 'AAL2'
  return 'AAL1'
}

export function meetsAcr(achieved: Acr, required: Acr): boolean {
  return RANK[achieved] >= RANK[required]
}

// Enforce the role's required assurance floor (6a). A principal that cannot
// reach its role floor is denied platform access; for super_admin (AAL3) with
// WebAuthn deferred, this gates login closed. The message carries only enum
// values, never a secret (S10.5).
export function enforceRoleAssurance(requiredAcr: Acr, achievedAcr: Acr): void {
  if (!meetsAcr(achievedAcr, requiredAcr)) {
    throw new AuthzError('assurance-insufficient', `requires ${requiredAcr}, reached ${achievedAcr}`)
  }
}
