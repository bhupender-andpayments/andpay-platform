import type { LeanClaim, PrincipalClass, Mode, Scope, Plane, Acr, Amr } from '@andpay/authz'
import type { KmsSigningPort } from './ports/kms-signing.js'

export interface IssueInput {
  principalId: string
  cls: PrincipalClass
  mode: Mode
  scope: Scope
  psr: string
  epoch: number
  /** Login handle, display attribution only (see LeanClaim.hdl). Humans only. */
  hdl?: string
  aud: Plane
  acr?: Acr
  amr?: Amr[]
  authTime?: number
}

export interface IssueDeps {
  signer: KmsSigningPort
  iss: string
  ttlSec: number
  now?: number
}

// Issue a Decision-3 lean access token (16.3), signed via the KMS port off the
// hot path. IDs and enums only, never a secret (S10.5), with the one ruled
// exception of `hdl`, the operator's own login handle, carried for display
// attribution on the rows they write (see LeanClaim in @andpay/authz for the
// full reasoning). The assurance claims (acr/amr/auth_time) ride on human
// principals only; class 6 omits them (5f) and is never minted a JWT (it
// resolves locally to the same claim shape).
export async function issueAccessToken(input: IssueInput, deps: IssueDeps): Promise<string> {
  const claims: Record<string, unknown> = {
    cls: input.cls,
    mode: input.mode,
    scope: input.scope,
    psr: input.psr,
    epoch: input.epoch,
  }
  if (input.hdl !== undefined) claims.hdl = input.hdl
  if (input.acr !== undefined) claims.acr = input.acr
  if (input.amr !== undefined) claims.amr = input.amr
  if (input.authTime !== undefined) claims.auth_time = input.authTime

  return deps.signer.sign({
    claims,
    iss: deps.iss,
    sub: input.principalId,
    aud: input.aud,
    ttlSec: deps.ttlSec,
    now: deps.now,
  })
}

export type { LeanClaim }
