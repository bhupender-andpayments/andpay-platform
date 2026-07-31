// Step-up gate (6b) single-sourced in @andpay/authz (T2, DD2): the ops edge
// evaluates it locally without calling Auth (T4), so Auth re-imports the same
// primitive here instead of holding its own copy.
export { requireStepUp } from '@andpay/authz'

import { AuthzError, type LeanClaim } from '@andpay/authz'
import type { AuthDb } from './db.js'
import type { KmsSigningPort } from './ports/kms-signing.js'
import type { MfaAdapter } from './ports/mfa.js'
import { issueAccessToken } from './issue.js'
import { auditStandalone } from './audit.js'

export interface StepUpDeps {
  db: AuthDb
  signer: KmsSigningPort
  mfa: MfaAdapter
  mfaSecretResolver: (principalId: string) => Promise<string | undefined>
  iss: string
  accessTtlSec: number
  traceId: string
  now?: number
}

// Tier-1 step-up (6b, S15): re-present the enrolled TOTP against the CURRENT
// class-3 session (the presented claim is already JWKS-verified at the edge) to
// mint a fresh-auth_time D3 claim, WITHOUT rotating the refresh family. There is
// NO auth write to co-commit the 6e with (the minted token is a stateless signed
// JWT, no family/DB mutation), so BOTH the ALLOW and the DENY are a SYNCHRONOUS
// STANDALONE durable auditStandalone commit AWAITED before this function returns
// or throws (the Q1 pure-DENY pattern applied to a write-less operation,
// fail-closed: a commit failure propagates). The TOTP code, the secret, and the
// minted token are never logged (S7). No cross-principal: sub is the presented
// claim's, never a body field.
export async function stepUp(
  presentedClaim: LeanClaim,
  totp: string,
  deps: StepUpDeps,
): Promise<{ accessToken: string }> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const secret = await deps.mfaSecretResolver(presentedClaim.sub)
  const good = secret !== undefined && (await deps.mfa.verify({ secret, token: totp }))
  if (!good) {
    await auditStandalone(deps.db, {
      principalId: presentedClaim.sub, cls: 3, operation: 'step-up', decision: 'DENY',
      resourceIds: [], outcome: 'denied', reasonCode: 'mfa-failed', traceId: deps.traceId,
    })
    throw new AuthzError('mfa-failed')
  }
  const accessToken = await issueAccessToken(
    {
      principalId: presentedClaim.sub, cls: presentedClaim.cls, mode: presentedClaim.mode,
      scope: presentedClaim.scope, psr: presentedClaim.psr, epoch: presentedClaim.epoch,
      aud: presentedClaim.aud, acr: 'AAL2', amr: ['pwd', 'otp'], authTime: now,
    },
    { signer: deps.signer, iss: deps.iss, ttlSec: deps.accessTtlSec, now },
  )
  await auditStandalone(deps.db, {
    principalId: presentedClaim.sub, cls: 3, operation: 'step-up', decision: 'ALLOW',
    resourceIds: [], outcome: 'stepped-up', acr: 'AAL2', authTime: now, traceId: deps.traceId,
  })
  return { accessToken }
}
