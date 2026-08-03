import { randomUUID } from 'node:crypto'
import { authenticator } from 'otplib'
import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { emitAuthzAudit } from './audit.js'

export interface EnrollInput {
  targetPrincipalId: string
  targetAccountLabel: string
  enrolledByActor: string
  issuer: string
  // Custody seam (S7): persist the secret to Secrets Manager, return only the
  // reference. The raw secret NEVER touches the DB row or a log line. The
  // principalType is appended as a THIRD, optional argument (spec 14a task 5):
  // every pre-existing 2-arg implementation still type-checks and still runs
  // unchanged (JS ignores an extra argument it never declared), so the
  // internal-only custody callers already in production are byte-unchanged.
  // A principalType-aware custody adapter can use the 3rd argument to key the
  // secret by (principalId, principalType), so an internal and a vendor
  // operator sharing the same principalId value get distinct secrets.
  storeSecret: (principalId: string, secret: string, principalType?: string) => Promise<string>
  // Spec 14a task 5, additive: DEFAULT 'internal' so every existing call site
  // (which passes no principalType) is byte-unchanged. Discriminates the row
  // and the custody key from a second principal_type (vendor_operator).
  principalType?: 'internal' | 'vendor_operator'
  traceId: string
}

// Admin-seed TOTP enrollment (6a, spec 12 field 2). Generates a secret, custodies
// it, writes the mfa_enrollment row under auth_write with a co-committed 6e audit
// (check 3/4), and returns the otpauth:// provisioning URI ONCE (the only
// provisioning path without a notification rail; client-side QR in the ops
// portal, no server-side image gen). Idempotent-rotate on the target principal:
// the single active enrollment is replaced so a re-seed rotates the secret.
export async function enrollTotp(db: AuthDb, input: EnrollInput): Promise<{ otpauthUri: string }> {
  const principalType = input.principalType ?? 'internal'
  const secret = authenticator.generateSecret()
  const otpauthUri = authenticator.keyuri(input.targetAccountLabel, input.issuer, secret)
  const secretRef = await input.storeSecret(input.targetPrincipalId, secret, principalType)
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    // Scoped by (principalId, principalType): revoking a re-seed for one
    // principal_type must never touch the other type's active row, even when
    // both share the same principalId value (spec 14a task 5 disjointness).
    await tx.mfaEnrollment.updateMany({ where: { principalId: input.targetPrincipalId, principalType, status: 'active' }, data: { status: 'revoked' } })
    await tx.mfaEnrollment.create({
      data: { id: randomUUID(), principalId: input.targetPrincipalId, principalType, factor: 'totp', secretRef, status: 'active', enrolledByActor: input.enrolledByActor },
    })
    await emitAuthzAudit(tx, {
      principalId: input.targetPrincipalId, cls: 3, operation: 'mfa-enroll', decision: 'ALLOW',
      resourceIds: [], outcome: 'enrolled', traceId: input.traceId,
    })
  })
  return { otpauthUri }
}
