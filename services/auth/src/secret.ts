import { randomBytes, createHash } from 'node:crypto'
import type { Mode } from '@andpay/authz'

// Mint a class-6 secret (5a/5c): a 256-bit CSPRNG value presented as
// apsk_{live|test}_<body><checksum>. The body is base64url(32 bytes); the
// 4-char checksum lets a secret scanner recognize and validate the format
// (GitHub's documented token-format rationale). The secret is shown ONCE and
// stored ONLY as a peppered HMAC; the display fingerprint is a non-reversible
// hash prefix, so nothing derived from the raw characters is persisted (S4).
export function mintSecret(mode: Mode): { secret: string; fingerprint: string } {
  const body = randomBytes(32).toString('base64url')
  const checksum = createHash('sha256').update(body).digest('hex').slice(0, 4)
  const secret = `apsk_${mode}_${body}${checksum}`
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 8)
  return { secret, fingerprint }
}
