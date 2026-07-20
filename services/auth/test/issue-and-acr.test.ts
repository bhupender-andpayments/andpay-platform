import { describe, it, expect } from 'vitest'
import { verifyAccessToken, type LeanClaim } from '@andpay/authz'
import { LocalEs256Adapter } from '../src/ports/kms-signing.js'
import { issueAccessToken } from '../src/issue.js'
import { computeAcr, enforceRoleAssurance, meetsAcr } from '../src/assurance.js'
import { requireStepUp } from '../src/stepup.js'
import { AUTH_ISS } from '../src/index.js'
import { ROLES } from '../src/config/roles.js'
import { STEP_UP_CATALOG } from '../src/config/step-up-catalog.js'

describe('D3 token issuance and local verify (check 1)', () => {
  it('issues a class-3 token that verifies locally with the lean claim shape', async () => {
    const signer = await LocalEs256Adapter.create('dev-1')
    const jwt = await issueAccessToken(
      { principalId: 'prn_1', cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, aud: 'andpay:internal-admin', acr: 'AAL2', amr: ['pwd', 'otp'], authTime: 1000 },
      { signer, iss: AUTH_ISS, ttlSec: 600, now: 1000 },
    )
    const claim = await verifyAccessToken(jwt, { jwks: await signer.jwks(), expectedIss: AUTH_ISS, expectedAud: 'andpay:internal-admin', now: 1001 })
    expect(claim).toMatchObject({ cls: 3, mode: 'live', psr: 'role:admin', epoch: 1, acr: 'AAL2', sub: 'prn_1' })
    expect(claim.amr).toEqual(['pwd', 'otp'])
  })

  it('rejects a wrong audience and an alg:none forgery (RFC 8725, distinct plane)', async () => {
    const signer = await LocalEs256Adapter.create('dev-1')
    const jwt = await issueAccessToken(
      { principalId: 'prn_1', cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, aud: 'andpay:internal-admin', acr: 'AAL2', amr: ['pwd', 'otp'], authTime: 1000 },
      { signer, iss: AUTH_ISS, ttlSec: 600, now: 1000 },
    )
    const jwks = await signer.jwks()
    await expect(verifyAccessToken(jwt, { jwks, expectedIss: AUTH_ISS, expectedAud: 'andpay:vendor', now: 1001 })).rejects.toThrow()
    const payload = jwt.split('.')[1]
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: 'dev-1', typ: 'at+jwt' })).toString('base64url')
    await expect(
      verifyAccessToken(`${noneHeader}.${payload}.`, { jwks, expectedIss: AUTH_ISS, expectedAud: 'andpay:internal-admin', now: 1001 }),
    ).rejects.toThrow()
  })
})

describe('assurance and the acr gate (6a, check 2)', () => {
  it('a password alone reaches only AAL1; a password plus TOTP reaches AAL2', () => {
    expect(computeAcr(['pwd'])).toBe('AAL1')
    expect(computeAcr(['pwd', 'otp'])).toBe('AAL2')
  })

  it('denies a class-3 login that cannot reach the AAL2 platform floor', () => {
    const adminFloor = ROLES.admin!.requiredAcr
    expect(() => enforceRoleAssurance(adminFloor, computeAcr(['pwd']))).toThrow()
    expect(() => enforceRoleAssurance(adminFloor, computeAcr(['pwd', 'otp']))).not.toThrow()
  })

  it('an AAL3-required super_admin path denies an AAL2 proof (WebAuthn deferred)', () => {
    const superFloor = ROLES.super_admin!.requiredAcr
    expect(superFloor).toBe('AAL3')
    expect(() => enforceRoleAssurance(superFloor, 'AAL2')).toThrow()
    expect(meetsAcr('AAL2', 'AAL3')).toBe(false)
  })
})

describe('step-up gate (6b, freshness against auth_time not iat)', () => {
  const base: LeanClaim = {
    iss: AUTH_ISS, sub: 'prn_1', aud: 'andpay:internal-admin', iat: 0, exp: 0, nbf: 0, jti: 'j',
    cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 1000,
  }
  const entry = STEP_UP_CATALOG['vendor_credential:create']!

  it('allows a fresh AAL2 claim to create a vendor credential', () => {
    expect(() => requireStepUp(base, entry, 1100)).not.toThrow()
  })
  it('denies a stale auth_time', () => {
    expect(() => requireStepUp(base, entry, 1000 + 301)).toThrow()
  })
  it('denies an acr below the required minimum', () => {
    expect(() => requireStepUp({ ...base, acr: 'AAL1' }, entry, 1100)).toThrow()
  })
})
