import type { Acr } from '@andpay/authz'

// The super_admin assurance floor is CODEOWNERS-gated config-as-code (S23), not
// a runtime control plane. The CODE DEFAULT is AAL3 (6a: hardware phishing-
// resistant for the all-tenant super-role). For the SINGLE-TENANT PILOT ONLY a
// config flag lowers it to AAL2 (the 2026-07-30 super_admin-extended ruling,
// which supersedes the earlier structurally-closed guardrail for the pilot).
// This leaves assurance.ts (computeAcr) UNCHANGED: AAL3 stays unreachable in
// code (no WebAuthn), so the only lever is this floor. Flipping the flag off
// (or removing it) makes super_admin login DENY at AAL2 again, a one-line
// revert, the hard gate at the second tenant.
export const SUPER_ADMIN_ACR_DEFAULT: Acr = 'AAL3'
export const SUPER_ADMIN_ACR_PILOT: Acr = 'AAL2'

export function resolveSuperAdminAcr(env: Record<string, string | undefined> = process.env): Acr {
  return env.ANDPAY_PILOT_SUPER_ADMIN_AAL2 === 'true' ? SUPER_ADMIN_ACR_PILOT : SUPER_ADMIN_ACR_DEFAULT
}
