import { verify as argonVerify } from '@node-rs/argon2'
import { AuthzError, type Acr, type Amr } from '@andpay/authz'
import type { AuthDb } from './db.js'
import type { KmsSigningPort } from './ports/kms-signing.js'
import type { MfaAdapter } from './ports/mfa.js'
import { computeAcr, enforceRoleAssurance } from './assurance.js'
import type { SecretRefResolver } from './factor.js'
import { issueAccessToken } from './issue.js'
import { issueRefreshFamily } from './refresh.js'
import { auditStandalone } from './audit.js'
import { ROLES } from './config/roles.js'
import { INTERNAL_ADMIN_PLANE } from './config/audiences.js'

export interface LoginDeps {
  db: AuthDb
  signer: KmsSigningPort
  // The enrolled second-factor adapter (TOTP in this slice).
  mfa: MfaAdapter
  // Custody seam (S7): the row holds only secret_ref, never the secret.
  // Resolves a custodied secret from an enrollment row's OWN reference. See
  // factor.ts: keying custody by principal alone is what let a revoked factor
  // keep working and let a pending attempt clobber a live one.
  resolveSecretRef: SecretRefResolver
  iss: string
  accessTtlSec: number
  idleSec: number
  absoluteSec: number
  clientBind: string
  traceId: string
  now?: number
}

// The enrollment token is deliberately short lived: it exists only to carry the
// operator from the password prompt to a scanned QR code in one sitting.
const ENROLLMENT_TOKEN_TTL_SEC = 600

export interface LoginResult {
  // Absent on the two intermediate outcomes below (mfaRequired), where the
  // password verified but no session has been established yet.
  accessToken?: string
  // Absent on the enrollment-required outcome: that path opens NO refresh
  // family, so there is no session to extend. Optional rather than an empty
  // string so the caller is forced by the type to handle its absence.
  refreshToken?: string
  principalId: string
  acr: Acr
  // Set only when the caller must complete TOTP enrollment before it can hold a
  // real session. accessToken is then an enrollment-only token.
  enrollmentRequired?: boolean
  // Set when the password verified but the enrolled second factor was not
  // presented. Carries NO token: it is a "keep going" answer, not a session.
  //
  // This DISCLOSES that the password was correct, which the previous uniform
  // 401 deliberately hid. Ruled by Bhupender 2026-08-06: a wrong password
  // silently advancing to the code screen, then failing vaguely, was a worse
  // failure in practice than the disclosure. Brute-force remains controlled by
  // the per-source throttle at the edge (6d), which is the standard mitigation.
  // A wrong password still returns the uniform authn-failed 401, so the handle
  // itself is never enumerable.
  mfaRequired?: boolean
}

// Class-3 human login (16.1). Verifies the Argon2id password (S4), optionally a
// second factor, computes the achieved assurance (6a), and enforces the role's
// assurance floor: a login that cannot reach the floor is denied platform access
// (a password alone is AAL1, which fails the AAL2 floor; super_admin needs AAL3,
// which is unattainable in v1 so its login is gated closed). On success it mints
// a D3 access token and opens a refresh-token family (6b).
export async function login(
  handle: string,
  password: string,
  totp: string | undefined,
  deps: LoginDeps,
): Promise<LoginResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)

  const principal = await deps.db.internalPrincipal.findUnique({ where: { loginHandle: handle } })

  // Spec 12 Task 4: a pure login-DENY has no auth write to ride, so its 6e is a
  // SYNCHRONOUS STANDALONE durable commit BEFORE the DENY is observable to the
  // caller (the Q1 verdict invariant). auditStandalone opens its own auth_write
  // tx and awaits the commit; only after it returns do we throw. Declared AFTER
  // the principal lookup so the unknown-handle DENY records 'unknown' and every
  // later DENY records the resolved principal.id. The thrown error (type + code)
  // that the caller/edge maps by (err.code) and the uniform-failure behavior are
  // unchanged; only an internal audit is added ahead of the throw.
  const denyThrow = async (reasonCode: string, err: AuthzError): Promise<never> => {
    await auditStandalone(deps.db, {
      principalId: principal?.id ?? 'unknown',
      cls: 3,
      operation: 'login',
      decision: 'DENY',
      resourceIds: [],
      outcome: 'denied',
      reasonCode,
      traceId: deps.traceId,
    })
    throw err
  }

  // Uniform failure: never reveal whether the handle exists or the password was
  // the wrong part (and never log the presented password, S4).
  // Spec 12 Task 4: route each DENY through denyThrow so the 6e commits first.
  if (!principal || principal.status !== 'ACTIVE') return denyThrow('authn-failed', new AuthzError('authn-failed'))
  if (!(await argonVerify(principal.passwordHash, password))) return denyThrow('authn-failed', new AuthzError('authn-failed'))

  // The principal's ACTIVE enrollment, read ONCE and used for two decisions
  // below: whether a presented factor is verifiable at all, and whether the
  // first-login enrollment path applies.
  const activeEnrollment = await deps.db.mfaEnrollment.findFirst({
    where: { principalId: principal.id, principalType: 'internal', status: 'active' },
    select: { id: true, secretRef: true },
  })

  const amr: Amr[] = ['pwd']
  if (totp !== undefined) {
    // A presented factor is only verifiable against an ACTIVE enrollment, and
    // only through THAT row's own secret reference (factor.ts explains why both
    // halves are load-bearing). The enrollment row is the authority on whether
    // a factor exists; custody only answers what its secret is.
    const secret =
      activeEnrollment === null || activeEnrollment.secretRef === null
        ? undefined
        : await deps.resolveSecretRef(activeEnrollment.secretRef)
    const good = secret !== undefined && (await deps.mfa.verify({ secret, token: totp }))
    // Spec 12 Task 4: audit the mfa DENY before throwing (same uniform failure).
    if (!good) return denyThrow('mfa-failed', new AuthzError('mfa-failed'))
    amr.push('otp')
  }

  const acr = computeAcr(amr)
  const role = ROLES[principal.role]
  // Spec 12 Task 4 (review Minor 1): route the post-auth role-config-miss DENY
  // through denyThrow too, so it emits its synchronous durable 6e DENY before the
  // throw. This closes the check-4 "every login DENY audits" invariant with no
  // known holes. The thrown error type + code ('unknown-role') are unchanged.
  if (!role) return denyThrow('unknown-role', new AuthzError('unknown-role'))
  // Spec 12 Task 4: the AAL-floor DENY audits before it throws. enforceRoleAssurance
  // still performs the exact floor check (single source of truth); on failure we
  // audit the assurance-insufficient DENY and throw the same AuthzError code the
  // caller/edge maps by (err.code), so the HTTP-facing outcome is unchanged.
  try {
    enforceRoleAssurance(role.requiredAcr, acr)
  } catch {
    // First-login TOTP self-enrollment (Bhupender ruling 2026-08-06). A
    // principal who authenticated by password but has NO active enrollment
    // cannot reach the AAL2 floor and previously had no way to ever reach it:
    // /enroll requires an admin token with AAL2 step-up, so a brand new
    // operator could obtain no token at all. That was a hard onboarding block.
    //
    // Instead of the DENY, mint a SINGLE-PURPOSE token: psr role:enrollment_pending
    // (exactly one permission, mfa:enroll), a short TTL, and NO refresh family, so
    // it cannot be silently extended and reaches no ops surface. The principal's
    // real role floor is NOT satisfied and its real role is never stamped.
    //
    // Narrow by construction: only when NO active enrollment exists, and only
    // when no totp was presented (a wrong code must stay a uniform mfa DENY,
    // never a downgrade into enrollment). Rebinding an EXISTING factor is
    // refused in enrollTotp, so this path can add a first factor and never
    // replace one.
    // A code WAS presented and still fell short of the floor: a genuine denial.
    if (totp !== undefined) {
      return denyThrow('assurance-insufficient', new AuthzError('assurance-insufficient'))
    }

    // Password verified, an enrolled factor exists, no code presented yet. This
    // is a continuation, not a denial, so it emits no DENY: the previous
    // behaviour audited an assurance-insufficient DENY on every ordinary
    // sign-in, which buried real denials in routine noise.
    if (activeEnrollment !== null) {
      return { principalId: principal.id, acr, mfaRequired: true }
    }

    const enrollmentToken = await issueAccessToken(
      {
        principalId: principal.id,
        cls: 3,
        mode: 'live',
        scope: {},
        psr: 'role:enrollment_pending',
        epoch: 1,
        aud: INTERNAL_ADMIN_PLANE,
        acr,
        amr,
        authTime: now,
      },
      { signer: deps.signer, iss: deps.iss, ttlSec: ENROLLMENT_TOKEN_TTL_SEC, now },
    )
    // The outcome is audited like any other login decision. It is an ALLOW of a
    // strictly narrower thing, so it records its own outcome rather than
    // borrowing 'authenticated'.
    await auditStandalone(deps.db, {
      principalId: principal.id,
      cls: 3,
      operation: 'login',
      decision: 'ALLOW',
      resourceIds: [],
      outcome: 'enrollment-required',
      reasonCode: 'enrollment-required',
      traceId: deps.traceId,
    })
    return { accessToken: enrollmentToken, principalId: principal.id, acr, enrollmentRequired: true }
  }

  const accessToken = await issueAccessToken(
    {
      principalId: principal.id,
      cls: 3,
      mode: 'live',
      scope: {},
      psr: `role:${principal.role}`,
      epoch: 1,
      aud: INTERNAL_ADMIN_PLANE,
      acr,
      amr,
      authTime: now,
    },
    { signer: deps.signer, iss: deps.iss, ttlSec: deps.accessTtlSec, now },
  )
  // Spec 12 Task 4: pass the ALLOW 6e record into issueRefreshFamily so it
  // CO-COMMITS INSIDE the family-create tx (Task 3 wired the optional audit
  // param). The prior best-effort trailing auditStandalone ALLOW block is removed:
  // 10c overruled best-effort-after-write as an S15 violation, so the ALLOW audit
  // now co-commits with the auth write (an aborted family-create leaves 0 refresh
  // rows AND 0 authz.audit rows, check 4). The minted token and refresh-family
  // semantics are unchanged.
  const { refreshToken } = await issueRefreshFamily(principal.id, deps.clientBind, {
    db: deps.db,
    idleSec: deps.idleSec,
    absoluteSec: deps.absoluteSec,
    now,
    audit: {
      principalId: principal.id,
      cls: 3,
      operation: 'login',
      decision: 'ALLOW',
      resourceIds: [],
      outcome: 'authenticated',
      acr,
      authTime: now,
      traceId: deps.traceId,
    },
  })

  return { accessToken, refreshToken, principalId: principal.id, acr }
}
