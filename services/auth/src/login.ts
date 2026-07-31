import { verify as argonVerify } from '@node-rs/argon2'
import { AuthzError, type Acr, type Amr } from '@andpay/authz'
import type { AuthDb } from './db.js'
import type { KmsSigningPort } from './ports/kms-signing.js'
import type { MfaAdapter } from './ports/mfa.js'
import { computeAcr, enforceRoleAssurance } from './assurance.js'
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
  // Custody seam: resolves the principal's enrolled factor secret from Secrets
  // Manager in production (the row holds only secret_ref, never the secret, S4).
  mfaSecretResolver: (principalId: string) => Promise<string | undefined>
  iss: string
  accessTtlSec: number
  idleSec: number
  absoluteSec: number
  clientBind: string
  traceId: string
  now?: number
}

export interface LoginResult {
  accessToken: string
  refreshToken: string
  principalId: string
  acr: Acr
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

  const amr: Amr[] = ['pwd']
  if (totp !== undefined) {
    const secret = await deps.mfaSecretResolver(principal.id)
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
    return denyThrow('assurance-insufficient', new AuthzError('assurance-insufficient'))
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
