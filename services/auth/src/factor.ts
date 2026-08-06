import type { AuthDb } from './db.js'

// Resolves a custodied secret from the reference stored on its enrollment row
// (Secrets Manager in production). Keyed by REFERENCE, never by principal: a
// principal can hold several enrollment rows over time (an active factor, a
// pending first-time attempt, revoked history) and each owns a distinct secret.
export type SecretRefResolver = (secretRef: string) => Promise<string | undefined>

/**
 * The ONLY way a second factor's secret may be obtained for verification.
 *
 * It answers with a secret exclusively when the principal holds an ACTIVE
 * enrollment, and it reads that secret through the row's OWN secretRef. Both
 * halves matter, and each closes a defect that reached this branch:
 *
 *   1. Gating on the row makes revocation real. A resolver keyed on principalId
 *      alone kept returning the last-stored secret after a revoke, so a revoked
 *      authenticator still signed in and an admin resetting a compromised
 *      factor left the old code working.
 *
 *   2. Reading through the row's own reference keeps enrollments independent.
 *      With one custody key per principal, writing a new secret overwrote the
 *      previous one, so an unconfirmed first-time attempt could silently
 *      invalidate a working factor.
 *
 * Every verification path (login, step-up, vendor login) goes through here, so
 * neither property can be reintroduced in one caller and not another.
 */
export async function resolveActiveFactorSecret(
  db: AuthDb,
  principalId: string,
  principalType: 'internal' | 'vendor_operator',
  resolveSecretRef: SecretRefResolver,
): Promise<string | undefined> {
  const active = await db.mfaEnrollment.findFirst({
    where: { principalId, principalType, status: 'active' },
    select: { secretRef: true },
  })
  // secret_ref is nullable in the schema: a row without one carries no usable
  // secret, so it can never satisfy a verification. Fail closed.
  if (active === null || active.secretRef === null) return undefined
  return resolveSecretRef(active.secretRef)
}
