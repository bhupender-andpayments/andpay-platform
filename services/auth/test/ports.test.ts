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

  // F-1 root cause. otplib's DEFAULT is window 0, i.e. no clock-skew tolerance
  // at all, so a code is valid only inside the exact 30-second step that minted
  // it. Every login here generates a code and THEN makes a call that runs a
  // deliberately-slow Argon2id verify first, so a request in flight across a
  // step boundary fails with the spec-12 uniform 401 that by design explains
  // nothing. Measured at 5000 trials per latency, the failure rate is exactly
  // latency/30s (0.48% at 150ms, 1.06% at 300ms); across 48 generate() call
  // sites that is a 20 to 40 percent chance of one spurious failure per gate,
  // which matches every sighting recorded under F-1 and F-1b.
  //
  // It is not a test-only defect: a real operator whose phone clock drifts a
  // few seconds hits the same wall. RFC 6238 section 5.2 explicitly allows one
  // step of skew, and real verifiers accept plus or minus one.
  //
  // Fails on the previous default: the adjacent-step code is rejected.
  it('accepts one step of clock skew (RFC 6238) and still rejects a stale code', async () => {
    const secret = authenticator.generateSecret()
    const totp = new TotpAdapter()
    const now = Date.now()

    // Mint codes for specific steps WITHOUT mutating the shared singleton's
    // options for anyone else: clone, use, discard.
    const at = (offsetMs: number): string => authenticator.clone({ epoch: now + offsetMs }).generate(secret)

    const previousStep = at(-30_000)
    const nextStep = at(30_000)
    const longExpired = at(-5 * 60_000)

    expect(await totp.verify({ secret, token: previousStep })).toBe(true)
    expect(await totp.verify({ secret, token: nextStep })).toBe(true)
    // Tolerance is ONE step, not "anything recent": five minutes stays invalid.
    expect(await totp.verify({ secret, token: longExpired })).toBe(false)
  })

  it('WebAuthn and SMS adapters are interface-only in v1 (AAL3/fallback deferred)', async () => {
    await expect(new WebauthnAdapter().verify({})).rejects.toThrow()
    await expect(new SmsAdapter().verify({})).rejects.toThrow()
  })
})
