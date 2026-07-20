import { describe, it, expect, beforeAll } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type KeyLike } from 'jose'
import { verifyAccessToken } from '../src/index.js'

let jwks: JSONWebKeySet
let priv: KeyLike
const iss = 'andpay-auth'
const aud = 'andpay:internal-admin' as const
// The custom claim body; the builder adds iss/sub/aud/iat/nbf/exp/jti.
const base = { cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 0 }

async function mint(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({ ...base, ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid: 'dev-1', typ: 'at+jwt', ...header })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject('prn_1')
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 600)
    .setJti('jti_1')
    .sign(priv)
}

beforeAll(async () => {
  const kp = await generateKeyPair('ES256', { extractable: true })
  priv = kp.privateKey
  const pub = await exportJWK(kp.publicKey)
  jwks = { keys: [{ ...pub, kid: 'dev-1', alg: 'ES256', use: 'sig' }] }
})

describe('verifyAccessToken (RFC 8725 hardening, S10)', () => {
  it('accepts a well-formed ES256 token and returns the lean claim', async () => {
    const claim = await verifyAccessToken(await mint(), { jwks, expectedIss: iss, expectedAud: aud })
    expect(claim.cls).toBe(3)
    expect(claim.acr).toBe('AAL2')
    expect(claim.sub).toBe('prn_1')
    expect(claim.aud).toBe(aud)
    expect(claim.mode).toBe('live')
  })

  it('rejects alg:none (no unsigned tokens)', async () => {
    const parts = (await mint()).split('.')
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: 'dev-1', typ: 'at+jwt' })).toString('base64url')
    const forged = `${noneHeader}.${parts[1]}.`
    await expect(verifyAccessToken(forged, { jwks, expectedIss: iss, expectedAud: aud })).rejects.toThrow()
  })

  it('rejects a wrong audience (distinct-plane, 105f)', async () => {
    const t = await mint()
    await expect(verifyAccessToken(t, { jwks, expectedIss: iss, expectedAud: 'andpay:vendor' })).rejects.toThrow()
  })

  it('rejects a wrong issuer', async () => {
    const t = await mint()
    await expect(verifyAccessToken(t, { jwks, expectedIss: 'someone-else', expectedAud: aud })).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 10_000
    const t = await new SignJWT(base)
      .setProtectedHeader({ alg: 'ES256', kid: 'dev-1', typ: 'at+jwt' })
      .setIssuer(iss).setAudience(aud).setSubject('prn_1')
      .setIssuedAt(past).setNotBefore(past).setExpirationTime(past + 60).setJti('jti_old')
      .sign(priv)
    await expect(verifyAccessToken(t, { jwks, expectedIss: iss, expectedAud: aud })).rejects.toThrow()
  })

  it('rejects a denylisted sub or jti even when otherwise valid (D3 emergency revocation)', async () => {
    const t = await mint()
    await expect(
      verifyAccessToken(t, { jwks, expectedIss: iss, expectedAud: aud, denylist: new Set(['prn_1']) }),
    ).rejects.toThrow()
    await expect(
      verifyAccessToken(t, { jwks, expectedIss: iss, expectedAud: aud, denylist: new Set(['jti_1']) }),
    ).rejects.toThrow()
  })
})
