import {
  resolveEdgeCredential,
  verifyAccessToken,
  type LeanClaim,
  type Mode,
  type Plane,
  type CredentialProjectionRow,
  type VerifyOptions,
} from '@andpay/authz'
import { EdgeAuthError } from './errors.js'

export type { CredentialProjectionRow }

export interface ResolveDeps {
  // The 5c pepper, injected at runtime by the edge process. Never bundled,
  // never stored by this package.
  pepper: Buffer | string
  // One local, synchronous lookup by the peppered hash. Zero network calls
  // per request (5e). This is the ONLY external interaction a caller wires.
  lookup: (pepperedHashHex: string) => CredentialProjectionRow | undefined
  expectedPlane: Plane
  expectedMode: Mode
  denylist?: ReadonlySet<string>
  // A JWT is only accepted where a JWKS and issuer are wired. The vendor
  // edge in v1 wires neither (class 6 never presents a JWT, 105f), so
  // omitting these makes any JWT-shaped credential fail closed.
  jwks?: VerifyOptions['jwks']
  expectedIss?: string
  leewaySec?: number
  now?: number
}

const BEARER_PREFIX = 'Bearer '

// Resolve a presented credential (an apsk_ edge secret, or a Decision-3 JWT
// on an edge that wires a JWKS) to the uniform lean claim, entirely LOCALLY
// (T4/S14/5e): zero network call to Auth on the request path. Fail-CLOSED:
// every unhappy path throws, never returns a partial claim, and the
// presented secret is never put in a log line or a thrown error message
// (S4/5c).
export async function resolveClaimFromAuthHeader(
  authHeader: string | undefined,
  deps: ResolveDeps,
): Promise<LeanClaim> {
  if (!authHeader) throw new EdgeAuthError('missing-credential')
  if (!authHeader.startsWith(BEARER_PREFIX)) throw new EdgeAuthError('malformed-authorization')

  const secret = authHeader.slice(BEARER_PREFIX.length)

  let claim: LeanClaim
  if (secret.startsWith('apsk_')) {
    claim = resolveEdgeCredential(secret, {
      pepper: deps.pepper,
      lookup: deps.lookup,
      denylist: deps.denylist,
      expectedPlane: deps.expectedPlane,
      expectedMode: deps.expectedMode,
      now: deps.now,
    })
  } else {
    // A JWT. The vendor edge wires no human JWKS in v1 (105f): without a
    // jwks/issuer configured, any JWT-shaped credential is rejected, never
    // partially verified.
    if (!deps.jwks || !deps.expectedIss) throw new EdgeAuthError('jwt-not-supported-on-this-edge')
    claim = await verifyAccessToken(secret, {
      jwks: deps.jwks,
      expectedIss: deps.expectedIss,
      expectedAud: deps.expectedPlane,
      leewaySec: deps.leewaySec,
      now: deps.now,
      denylist: deps.denylist,
      expectedMode: deps.expectedMode,
    })
    // Class 6 is produced ONLY by local apsk_ resolution and is NEVER minted
    // as a JWT (105f/5f); a JWT claiming class 6 is a forged or corrupted
    // token, rejected regardless of signature validity.
    if (claim.cls === 6) throw new EdgeAuthError('class6-jwt-rejected')
  }

  // Plane binding: class 6 must never cross to a non-vendor plane. This is
  // enforced here in addition to resolveEdgeCredential stamping aud from
  // opts.expectedPlane, so a caller cannot accidentally authorize a class-6
  // claim against the internal-admin plane by misconfiguring expectedPlane.
  if (claim.cls === 6 && claim.aud !== 'andpay:vendor') throw new EdgeAuthError('class6-wrong-plane')

  return claim
}
