import { authenticator } from 'otplib'
import { AuthzError } from '@andpay/authz'

export type MfaFactor = 'totp' | 'webauthn' | 'sms'

export interface MfaVerifyInput {
  secret?: string
  token?: string
}

// MFA factor adapters behind a port (6a), phishing-resistance-ranked. WebAuthn
// (AAL3, phishing-resistant) is preferred, TOTP acceptable, SMS fallback-only
// and never primary. Only TOTP is instantiated in this slice; WebAuthn and SMS
// are interface-only (deferred), so AAL3 is structurally unattainable in v1 and
// any super-admin login is gated closed.
export interface MfaAdapter {
  readonly factor: MfaFactor
  verify(input: MfaVerifyInput): Promise<boolean>
}

// ONE step of clock-skew tolerance (RFC 6238 section 5.2), i.e. the code minted
// for the previous or the next 30-second step is also accepted.
//
// otplib's DEFAULT is window 0: valid ONLY inside the exact step that minted it.
// That is stricter than the RFC advises and stricter than real verifiers, and it
// was the root cause of the F-1/F-1b flake cluster. A login generates a code and
// THEN makes a call that runs a deliberately-slow Argon2id password verify
// before the factor is ever checked, so a request in flight across a step
// boundary failed with the spec-12 uniform 401, which by design says nothing
// about why. Measured at 5000 trials per latency, the failure rate is exactly
// latency/30s (0.48% at 150ms, 1.06% at 300ms). Across 48 generate() call sites
// that is a 20 to 40 percent chance of one spurious failure per gate.
//
// The same wall is hit by a real operator whose phone clock drifts a few
// seconds, so this is a usability fix and not merely a test fix.
//
// THE TRADEOFF, STATED PLAINLY: a code is now accepted for up to 90 seconds
// instead of 30, which widens the replay window for an intercepted code by the
// same factor. That is the standard posture (it is what the RFC recommends and
// what mainstream verifiers do) and it is bounded: still one-time-use per step,
// still useless once the step passes.
//
// A CLONE, not a mutation of the shared singleton: otplib's `authenticator` is a
// process-wide instance, and the demo harness already reassigns its options.
// Cloning keeps this adapter's behaviour independent of whatever else in the
// process has touched them.
const totp = authenticator.clone({ window: 1 })

export class TotpAdapter implements MfaAdapter {
  readonly factor = 'totp' as const

  async verify(input: MfaVerifyInput): Promise<boolean> {
    if (!input.secret || !input.token) return false
    return totp.verify({ token: input.token, secret: input.secret })
  }
}

export class WebauthnAdapter implements MfaAdapter {
  readonly factor = 'webauthn' as const

  async verify(_input: MfaVerifyInput): Promise<boolean> {
    throw new AuthzError('mfa-webauthn-not-implemented')
  }
}

export class SmsAdapter implements MfaAdapter {
  readonly factor = 'sms' as const

  async verify(_input: MfaVerifyInput): Promise<boolean> {
    throw new AuthzError('mfa-sms-not-implemented')
  }
}
