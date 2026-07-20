// Redact a class-6 secret (any apsk_ token) before the first log line (5c, S4).
// The redacted form keeps the mode prefix and drops the body; logs carry the
// api_ id and the display fingerprint, never the secret. Passwords and MFA codes
// have no recognizable pattern and are NEVER passed to a log by construction
// (auth errors carry only fixed code phrases, never the presented material).
export function redactSecrets(text: string): string {
  return text.replace(/apsk_(live|test)_[A-Za-z0-9_-]+/g, 'apsk_$1_[REDACTED]')
}
