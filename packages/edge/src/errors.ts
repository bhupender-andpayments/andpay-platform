// One typed error for the edge's OWN failures: a missing or malformed
// Authorization header, a JWT presented on an edge that wires no JWKS, a
// class-6 claim minted as a JWT (never valid, 105f/5f), or a class-6 claim
// crossing to a non-vendor plane. `@andpay/authz`'s AuthzError (thrown by
// resolveEdgeCredential/verifyAccessToken) propagates unchanged past this
// module; it is not wrapped or re-thrown.
//
// The message is a fixed code phrase and MUST NOT interpolate the presented
// secret, a token, or any PII (S4, S7, 5c: redact before the first log line).
export class EdgeAuthError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'EdgeAuthError'
    this.code = code
  }
}
