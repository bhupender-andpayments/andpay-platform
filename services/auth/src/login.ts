import { verify as argonVerify } from '@node-rs/argon2'
import { AuthzError, type Acr, type Amr } from '@andpay/authz'
import type { AuthDb } from './db.js'
import type { KmsSigningPort } from './ports/kms-signing.js'
import type { MfaAdapter } from './ports/mfa.js'
import { computeAcr, enforceRoleAssurance } from './assurance.js'
import { issueAccessToken } from './issue.js'
import { issueRefreshFamily } from './refresh.js'
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
  // Uniform failure: never reveal whether the handle exists or the password was
  // the wrong part (and never log the presented password, S4).
  if (!principal || principal.status !== 'ACTIVE') throw new AuthzError('authn-failed')
  if (!(await argonVerify(principal.passwordHash, password))) throw new AuthzError('authn-failed')

  const amr: Amr[] = ['pwd']
  if (totp !== undefined) {
    const secret = await deps.mfaSecretResolver(principal.id)
    const good = secret !== undefined && (await deps.mfa.verify({ secret, token: totp }))
    if (!good) throw new AuthzError('mfa-failed')
    amr.push('otp')
  }

  const acr = computeAcr(amr)
  const role = ROLES[principal.role]
  if (!role) throw new AuthzError('unknown-role')
  enforceRoleAssurance(role.requiredAcr, acr)

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
  const { refreshToken } = await issueRefreshFamily(principal.id, deps.clientBind, {
    db: deps.db,
    idleSec: deps.idleSec,
    absoluteSec: deps.absoluteSec,
    now,
  })

  return { accessToken, refreshToken, principalId: principal.id, acr }
}
