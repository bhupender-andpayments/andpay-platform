import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import type { LeanClaim, Plane } from './claims.js'
import { AuthzError } from './errors.js'
import { isDenylisted } from './denylist.js'

export interface VerifyOptions {
  // The verifier holds only public keys (JWKS), never the signing key (D3).
  jwks: JSONWebKeySet
  expectedIss: string
  // Distinct audience per plane (16.3 point 6, 105f): a lower-trust token cannot
  // replay against a higher-trust plane because the verifier pins its own aud.
  expectedAud: Plane
  // Bounded clock-skew leeway (S22). Default 60s.
  leewaySec?: number
  // Seconds since epoch; override for deterministic tests. Defaults to now.
  now?: number
  // D3 emergency revocation: any principal id or jti, checked on the hot path.
  denylist?: ReadonlySet<string>
}

// Verify a Decision-3 access token LOCALLY against the JWKS (T4, never a call
// to Auth). RFC 8725 hardening is mandatory (S10): the algorithm is PINNED to
// ES256 at the verifier (this, not the header, kills algorithm confusion and
// rejects alg:none), and iss/aud/exp/nbf/iat/typ are all validated.
export async function verifyAccessToken(jwt: string, opts: VerifyOptions): Promise<LeanClaim> {
  const jwkSet = createLocalJWKSet(opts.jwks)
  let payload
  try {
    const res = await jwtVerify(jwt, jwkSet, {
      algorithms: ['ES256'],
      issuer: opts.expectedIss,
      audience: opts.expectedAud,
      typ: 'at+jwt',
      clockTolerance: opts.leewaySec ?? 60,
      currentDate: opts.now !== undefined ? new Date(opts.now * 1000) : undefined,
    })
    payload = res.payload
  } catch (err) {
    // Never surface token bytes; carry only the jose failure class name.
    throw new AuthzError('token-verify-failed', err instanceof Error ? err.name : 'verify-failed')
  }

  if (
    (typeof payload.sub === 'string' && isDenylisted(payload.sub, opts.denylist)) ||
    (typeof payload.jti === 'string' && isDenylisted(payload.jti, opts.denylist))
  ) {
    throw new AuthzError('denylisted')
  }

  return payload as unknown as LeanClaim
}
