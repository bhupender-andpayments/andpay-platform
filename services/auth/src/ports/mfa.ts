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

export class TotpAdapter implements MfaAdapter {
  readonly factor = 'totp' as const

  async verify(input: MfaVerifyInput): Promise<boolean> {
    if (!input.secret || !input.token) return false
    return authenticator.verify({ token: input.token, secret: input.secret })
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
