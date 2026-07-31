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
  // reference. The raw secret NEVER touches the DB row or a log line.
  storeSecret: (principalId: string, secret: string) => Promise<string>
  traceId: string
}

// Admin-seed TOTP enrollment (6a, spec 12 field 2). Generates a secret, custodies
// it, writes the mfa_enrollment row under auth_write with a co-committed 6e audit
// (check 3/4), and returns the otpauth:// provisioning URI ONCE (the only
// provisioning path without a notification rail; client-side QR in the ops
// portal, no server-side image gen). Idempotent-rotate on the target principal:
// the single active enrollment is replaced so a re-seed rotates the secret.
export async function enrollTotp(db: AuthDb, input: EnrollInput): Promise<{ otpauthUri: string }> {
  const secret = authenticator.generateSecret()
  const otpauthUri = authenticator.keyuri(input.targetAccountLabel, input.issuer, secret)
  const secretRef = await input.storeSecret(input.targetPrincipalId, secret)
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    await tx.mfaEnrollment.updateMany({ where: { principalId: input.targetPrincipalId, status: 'active' }, data: { status: 'revoked' } })
    await tx.mfaEnrollment.create({
      data: { id: randomUUID(), principalId: input.targetPrincipalId, factor: 'totp', secretRef, status: 'active', enrolledByActor: input.enrolledByActor },
    })
    await emitAuthzAudit(tx, {
      principalId: input.targetPrincipalId, cls: 3, operation: 'mfa-enroll', decision: 'ALLOW',
      resourceIds: [], outcome: 'enrolled', traceId: input.traceId,
    })
  })
  return { otpauthUri }
}
