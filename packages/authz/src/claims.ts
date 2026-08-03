// The Decision-3 lean claim model (architure_context.md 16.3), locked at
// spec-04 planning. Every principal, human or machine, resolves to this one
// shape so the Decision-2 two-gate evaluation is uniform regardless of how the
// principal arrived. Class 6 is produced by local resolution of api_/apsk_ and
// is never minted as a JWT (5a, 5f). IDs and enums only, never PII or a secret
// (S10.5, S7).

// Principal taxonomy (16.1). Classes 1, 2, 4, 5 are reserved for later specs;
// this slice exercises class 3 (internal humans), class 6 (vendor systems),
// and class 7 (vendor-operator humans, D122, spec 14a).
export type PrincipalClass = 1 | 2 | 3 | 4 | 5 | 6 | 7

// Live/test plane (S2/S16). Orthogonal to the audience, ANDed at evaluation,
// always present, never a request-body field.
export type Mode = 'live' | 'test'

// Authentication assurance level (6a, NIST 800-63B aligned). AAL1 single
// factor, AAL2 the human floor, AAL3 hardware phishing-resistant.
export type Acr = 'AAL1' | 'AAL2' | 'AAL3'

// Authentication method reference (6a, RFC 8176), the subset this platform
// uses. WebAuthn roaming keys map to hwk, platform authenticators to swk.
export type Amr = 'pwd' | 'otp' | 'sms' | 'hwk' | 'swk'

// One distinct audience per plane (16.3 point 6, 105f), so a lower-trust token
// can never replay against a higher-trust plane. Only internal-admin and vendor
// are exercised in the auth slice; the rest are reserved for later specs.
export type Plane =
  | 'andpay:internal-admin'
  | 'andpay:vendor'
  | 'andpay:merchant-api'
  | 'andpay:tenant-portal'
  | 'andpay:service'

// Scope is principal-specific and stays in the claim only where it is not
// derivable from static config (16.3). Class 3 carries an empty object (the
// scope ceiling resolves from the role via psr, per 4c and D121). Class 1/2/4
// later carry tid/mid/pids; class 6 carries its vendor id plus work queue.
export interface Scope {
  tid?: string
  mid?: string
  pids?: string[]
  vndr?: string
  wq?: string
}

// The lean access claim. A role or permission-set reference (psr), never the
// expanded permission list, so a role-definition change does not force a mass
// token refresh (16.3, FAT rejected).
export interface LeanClaim {
  iss: string
  sub: string
  aud: Plane
  iat: number
  exp: number
  nbf: number
  jti: string
  cls: PrincipalClass
  mode: Mode
  scope: Scope
  psr: string
  epoch: number
  // Assurance claims (6a/6b) ride on human principals only. Class 6 has no
  // acr/amr/auth_time (5f: assurance is the credential, no MFA, no session).
  acr?: Acr
  amr?: Amr[]
  auth_time?: number
}
