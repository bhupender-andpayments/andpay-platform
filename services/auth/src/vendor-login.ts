import { verify as argonVerify } from '@node-rs/argon2'
import { AuthzError, type Acr, type Amr } from '@andpay/authz'
import type { AuthDb } from './db.js'
import type { KmsSigningPort } from './ports/kms-signing.js'
import type { MfaAdapter } from './ports/mfa.js'
import { computeAcr, enforceRoleAssurance } from './assurance.js'
import { issueAccessToken } from './issue.js'
import { issueRefreshFamily } from './refresh.js'
import { auditStandalone } from './audit.js'
import { lookupVendorOperatorByUsername } from './vendor-operator.js'
import { VENDOR_OPERATOR_SET_NAME } from './config/vendor-sets.js'
import { VENDOR_PLANE } from './config/audiences.js'

// Spec 14a Task 6: the class-7 vendor-operator login. Mirrors login.ts's
// structure (uniform-failure DENY, synchronous-standalone 6e before the
// throw, the AAL2 floor) but is a SEPARATE module: login.ts (the internal
// class-3 path) is NOT modified (D6). Class 7 is a single external role at
// AAL2 (D122, Field 8); there is no per-operator role column to look up, so
// the required assurance is the fixed constant below, not a ROLES lookup.
const VENDOR_OPERATOR_REQUIRED_ACR: Acr = 'AAL2'

export interface VendorLoginDeps {
  db: AuthDb
  signer: KmsSigningPort
  mfa: MfaAdapter
  // Carry-forward 3: the vendor TOTP secret is fetched with a
  // (principalId, principalType)-keyed resolver, so a vendor_operator's secret
  // is fetched with the vendor key, distinct from any internal secret that
  // happens to share the same principalId value.
  mfaSecretResolver: (principalId: string, principalType: 'vendor_operator') => Promise<string | undefined>
  iss: string
  accessTtlSec: number
  idleSec: number
  absoluteSec: number
  clientBind: string
  traceId: string
  now?: number
}

export interface VendorLoginResult {
  accessToken: string
  refreshToken: string
  principalId: string
  acr: Acr
}

// Class-7 vendor-operator login. Verifies the Argon2id password (5c) AND the
// TOTP second factor (AAL2 is the only reachable/allowed floor: password-only
// is AAL1 and is DENIED, mirroring login.ts's assurance gate). On success,
// scope.vndr is RE-DERIVED from the stored vendor_operator row (carry-forward
// 1: the wire vndr_... string straight from the column, no fromUuid step; a
// caller-supplied vndr is never read, D99). Gates on status === 'ACTIVE'
// (carry-forward 2, uppercase, matching internal_principal/login.ts). A pure
// DENY has no auth write to ride, so its 6e is a SYNCHRONOUS STANDALONE
// durable commit BEFORE the DENY is observable to the caller (the Q1
// invariant, same pattern as login.ts's denyThrow). On success, mints via
// issueAccessToken (the vendor signing key, selected by aud:'andpay:vendor')
// and opens a vendor refresh family (principalType:'vendor_operator'),
// co-committing ONE 6e ALLOW inside that same auth write tx.
export async function vendorLogin(
  username: string,
  password: string,
  totp: string | undefined,
  deps: VendorLoginDeps,
): Promise<VendorLoginResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)

  const operator = await lookupVendorOperatorByUsername(deps.db, username)

  const denyThrow = async (reasonCode: string, err: AuthzError): Promise<never> => {
    await auditStandalone(deps.db, {
      principalId: operator?.id ?? 'unknown',
      cls: 7,
      operation: 'vendor_login',
      decision: 'DENY',
      resourceIds: [],
      outcome: 'denied',
      reasonCode,
      traceId: deps.traceId,
    })
    throw err
  }

  // Uniform failure: never reveal whether the username exists, whether it is
  // ACTIVE, or which part (password vs totp) was wrong (mirrors login.ts).
  if (!operator || operator.status !== 'ACTIVE') return denyThrow('authn-failed', new AuthzError('authn-failed'))
  if (!(await argonVerify(operator.passwordHash, password))) return denyThrow('authn-failed', new AuthzError('authn-failed'))

  const amr: Amr[] = ['pwd']
  if (totp !== undefined) {
    const secret = await deps.mfaSecretResolver(operator.id, 'vendor_operator')
    const good = secret !== undefined && (await deps.mfa.verify({ secret, token: totp }))
    if (!good) return denyThrow('mfa-failed', new AuthzError('mfa-failed'))
    amr.push('otp')
  }

  const acr = computeAcr(amr)
  // The AAL2 floor: a password-only presentation (AAL1) is denied (no role
  // lookup here, since class 7 has exactly one fixed-assurance role, D122).
  try {
    enforceRoleAssurance(VENDOR_OPERATOR_REQUIRED_ACR, acr)
  } catch {
    return denyThrow('assurance-insufficient', new AuthzError('assurance-insufficient'))
  }

  // Carry-forward 1: RE-DERIVE scope.vndr from the row, never from a request
  // field (D99). operator.vndrId is already the wire form (vndr_...); no
  // fromUuid step (that is the class-6 path, which reads a uuid column).
  const accessToken = await issueAccessToken(
    {
      principalId: operator.id,
      cls: 7,
      mode: 'live',
      scope: { vndr: operator.vndrId },
      psr: `vset:${VENDOR_OPERATOR_SET_NAME}`,
      epoch: 1,
      aud: VENDOR_PLANE,
      acr,
      amr,
      authTime: now,
    },
    { signer: deps.signer, iss: deps.iss, ttlSec: deps.accessTtlSec, now },
  )

  const { refreshToken } = await issueRefreshFamily(
    operator.id,
    deps.clientBind,
    {
      db: deps.db,
      idleSec: deps.idleSec,
      absoluteSec: deps.absoluteSec,
      now,
      audit: {
        principalId: operator.id,
        cls: 7,
        operation: 'vendor_login',
        decision: 'ALLOW',
        resourceIds: [],
        outcome: 'authenticated',
        acr,
        authTime: now,
        traceId: deps.traceId,
      },
    },
    'vendor_operator',
  )

  return { accessToken, refreshToken, principalId: operator.id, acr }
}
