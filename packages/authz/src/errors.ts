// One typed error for every authz failure. The message is a fixed code phrase
// and MUST NOT interpolate a secret, a token, a credential value, or any PII
// (S4, S7, 5c: redact before the first log line). Callers log err.code and the
// non-secret api_ id or principal id, never the presented material.
export class AuthzError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'AuthzError'
    this.code = code
  }
}
