import { randomUUID } from 'node:crypto'
import { authenticator } from 'otplib'
import type { AuthDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { emitAuthzAudit } from './audit.js'
import type { SecretRefResolver } from './factor.js'

// Raised when a FIRST-TIME-ONLY enrollment is attempted for a principal that
// already holds an active enrollment. This is the guard that makes password-only
// self-enrollment safe: without it, anyone holding the password could rotate the
// secret of an already-enrolled account and take it over. Admin re-seeding is
// unaffected (it does not set requireNoActiveEnrollment).
export class ActiveEnrollmentExistsError extends Error {
  readonly code = 'enrollment-exists'
  constructor() {
    super('an active enrollment already exists for this principal')
    this.name = 'ActiveEnrollmentExistsError'
  }
}

export interface EnrollInput {
  targetPrincipalId: string
  targetAccountLabel: string
  // Set by the self-enrollment path ONLY. When true the write refuses if an
  // active enrollment already exists, so this path can create a first factor
  // but can never replace one. Checked INSIDE the transaction, under the write
  // role, so it cannot be raced by two concurrent self-enrollments.
  requireNoActiveEnrollment?: boolean
  // Write the row as 'pending' rather than 'active': the secret exists but does
  // NOT count as an enrolled factor until confirmTotpEnrollment verifies a code
  // against it.
  //
  // Without this, merely DISPLAYING the QR enrolled the account. An operator
  // who opened the setup screen and walked away without scanning was left
  // enrolled against a secret nobody possessed, and every later sign-in
  // correctly demanded a code they could never produce: a permanent lockout.
  // Possession must be proven before a factor counts.
  pendingUntilConfirmed?: boolean
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
    // First-time-only gate, inside the tx so a concurrent pair of self-enroll
    // calls cannot both observe "no enrollment" and both write.
    if (input.requireNoActiveEnrollment === true) {
      const active = await tx.mfaEnrollment.findFirst({
        where: { principalId: input.targetPrincipalId, principalType, status: 'active' },
        select: { id: true },
      })
      if (active !== null) throw new ActiveEnrollmentExistsError()
    }
    const pending = input.pendingUntilConfirmed === true
    if (pending) {
      // Supersede only earlier UNCONFIRMED attempts. Re-opening the setup
      // screen must not disturb a confirmed factor, and abandoned attempts must
      // not accumulate.
      await tx.mfaEnrollment.updateMany({
        where: { principalId: input.targetPrincipalId, principalType, status: 'pending' },
        data: { status: 'revoked' },
      })
    } else {
      // Admin re-seed: rotate the confirmed factor.
      // Scoped by (principalId, principalType): revoking a re-seed for one
      // principal_type must never touch the other type's active row, even when
      // both share the same principalId value (spec 14a task 5 disjointness).
      await tx.mfaEnrollment.updateMany({ where: { principalId: input.targetPrincipalId, principalType, status: 'active' }, data: { status: 'revoked' } })
    }
    await tx.mfaEnrollment.create({
      data: { id: randomUUID(), principalId: input.targetPrincipalId, principalType, factor: 'totp', secretRef, status: pending ? 'pending' : 'active', enrolledByActor: input.enrolledByActor },
    })
    await emitAuthzAudit(tx, {
      principalId: input.targetPrincipalId, cls: 3, operation: 'mfa-enroll', decision: 'ALLOW',
      resourceIds: [], outcome: 'enrolled', traceId: input.traceId,
    })
  })
  return { otpauthUri }
}

// Raised when a confirmation code does not verify, or there is nothing pending
// to confirm. Deliberately ONE error for both: a caller learns only that the
// confirmation failed, never whether a pending enrollment existed.
export class EnrollmentConfirmationFailedError extends Error {
  readonly code = 'enrollment-confirmation-failed'
  constructor() {
    super('enrollment confirmation failed')
    this.name = 'EnrollmentConfirmationFailedError'
  }
}

export interface ConfirmEnrollInput {
  principalId: string
  principalType?: 'internal' | 'vendor_operator'
  totp: string
  // Read through the PENDING row's own reference, so confirming an unscanned
  // attempt can never be satisfied by some other enrollment's secret.
  resolveSecretRef: SecretRefResolver
  verify: (args: { secret: string; token: string }) => Promise<boolean>
  traceId: string
}

// Promotes a PENDING enrollment to active once the operator proves possession
// of the secret by presenting a code from it. This is the step that makes
// self-enrollment safe to abandon: until it succeeds the principal has no
// factor at all, so an unscanned QR leaves the account exactly as it was.
export async function confirmTotpEnrollment(db: AuthDb, input: ConfirmEnrollInput): Promise<void> {
  const principalType = input.principalType ?? 'internal'
  const candidate = await db.mfaEnrollment.findFirst({
    where: { principalId: input.principalId, principalType, status: 'pending' },
    orderBy: { enrolledAt: 'desc' },
    select: { id: true, secretRef: true },
  })
  if (candidate === null || candidate.secretRef === null) {
    throw new EnrollmentConfirmationFailedError()
  }
  const secret = await input.resolveSecretRef(candidate.secretRef)
  if (secret === undefined) throw new EnrollmentConfirmationFailedError()
  if (!(await input.verify({ secret, token: input.totp }))) {
    throw new EnrollmentConfirmationFailedError()
  }
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'auth_write')
    // Re-read inside the transaction: the row must still be pending at the
    // moment of promotion, so a concurrent re-open cannot activate a secret
    // that has since been superseded.
    const pending = await tx.mfaEnrollment.findFirst({
      where: { id: candidate.id, status: 'pending' },
      select: { id: true },
    })
    if (pending === null) throw new EnrollmentConfirmationFailedError()
    // Any previously confirmed factor is retired in the SAME transaction, so a
    // principal never holds two active factors.
    await tx.mfaEnrollment.updateMany({
      where: { principalId: input.principalId, principalType, status: 'active' },
      data: { status: 'revoked' },
    })
    await tx.mfaEnrollment.update({ where: { id: pending.id }, data: { status: 'active' } })
    await emitAuthzAudit(tx, {
      principalId: input.principalId, cls: 3, operation: 'mfa-enroll', decision: 'ALLOW',
      resourceIds: [], outcome: 'enrollment-confirmed', traceId: input.traceId,
    })
  })
}
