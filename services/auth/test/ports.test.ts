import { describe, it, expect } from 'vitest'
import { authenticator } from 'otplib'
import { verifyAccessToken } from '@andpay/authz'
import { LocalEs256Adapter } from '../src/ports/kms-signing.js'
import { LocalPepperAdapter } from '../src/ports/pepper.js'
import { TotpAdapter, WebauthnAdapter, SmsAdapter } from '../src/ports/mfa.js'

describe('KMS signing port (local ES256 dev adapter)', () => {
  it('signs a D3 token that verifies locally against its own JWKS (round-trip)', async () => {
    const signer = await LocalEs256Adapter.create('dev-1')
    const jwt = await signer.sign({
      claims: { cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 0 },
      iss: 'andpay-auth',
      sub: 'prn_1',
      aud: 'andpay:internal-admin',
      ttlSec: 600,
    })
    const claim = await verifyAccessToken(jwt, {
      jwks: await signer.jwks(),
      expectedIss: 'andpay-auth',
      expectedAud: 'andpay:internal-admin',
    })
    expect(claim.cls).toBe(3)
    expect(claim.sub).toBe('prn_1')
    expect(claim.acr).toBe('AAL2')
  })

  it('exposes only public keys in the JWKS (never the private key)', async () => {
    const signer = await LocalEs256Adapter.create('dev-1')
    const jwks = await signer.jwks()
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).not.toHaveProperty('d') // the EC private scalar must be absent
    expect(jwks.keys[0]?.kid).toBe('dev-1')
  })
})

describe('pepper port (local dev adapter)', () => {
  it('produces a stable 64-hex HMAC that differs per secret', () => {
    const p = new LocalPepperAdapter('dev-pepper-not-a-real-secret')
    const h1 = p.hmac('apsk_live_x')
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(p.hmac('apsk_live_x')).toBe(h1)
    expect(p.hmac('apsk_live_y')).not.toBe(h1)
  })
})

describe('MFA port', () => {
  it('TOTP adapter accepts a fresh code and rejects a wrong one (6a)', async () => {
    const secret = authenticator.generateSecret()
    const totp = new TotpAdapter()
    expect(totp.factor).toBe('totp')
    expect(await totp.verify({ secret, token: authenticator.generate(secret) })).toBe(true)
    expect(await totp.verify({ secret, token: '000000' })).toBe(false)
  })

  it('WebAuthn and SMS adapters are interface-only in v1 (AAL3/fallback deferred)', async () => {
    await expect(new WebauthnAdapter().verify({})).rejects.toThrow()
    await expect(new SmsAdapter().verify({})).rejects.toThrow()
  })
})
