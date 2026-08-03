import { describe, it, expect } from 'vitest'
import { verifyAccessToken } from '@andpay/authz'
import { LocalEs256Adapter } from '../src/ports/kms-signing.js'
import { INTERNAL_ADMIN_PLANE, VENDOR_PLANE } from '../src/config/audiences.js'

// Spec 14a task 2 (Fork D): a signer that selects the signing key by
// audience/plane and publishes BOTH public keys in the JWKS, so any verifier
// edge can validate either audience's token by kid.
describe('signer-by-audience (Fork D: multi-key signer, both keys in JWKS)', () => {
  async function buildMultiSigner() {
    const internal = await LocalEs256Adapter.create('int-1')
    const vendor = await LocalEs256Adapter.create('vendor-1')
    return LocalEs256Adapter.createMulti({
      [INTERNAL_ADMIN_PLANE]: internal,
      [VENDOR_PLANE]: vendor,
    })
  }

  it('selects the vendor key/kid when signing aud:andpay:vendor', async () => {
    const signer = await buildMultiSigner()
    const jwt = await signer.sign({
      claims: { cls: 6, mode: 'live', scope: {}, psr: 'vendor:x', epoch: 1 },
      iss: 'andpay-auth',
      sub: 'vndr_1',
      aud: VENDOR_PLANE,
      ttlSec: 600,
    })
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8'))
    expect(header.kid).toBe('vendor-1')
  })

  it('selects the internal key/kid when signing aud:andpay:internal-admin', async () => {
    const signer = await buildMultiSigner()
    const jwt = await signer.sign({
      claims: { cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 0 },
      iss: 'andpay-auth',
      sub: 'prn_1',
      aud: INTERNAL_ADMIN_PLANE,
      ttlSec: 600,
    })
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8'))
    expect(header.kid).toBe('int-1')
  })

  it('jwks() contains BOTH kids (aggregated, superset)', async () => {
    const signer = await buildMultiSigner()
    const jwks = await signer.jwks()
    const kids = jwks.keys.map((k) => k.kid).sort()
    expect(kids).toEqual(['int-1', 'vendor-1'])
    for (const k of jwks.keys) expect(k).not.toHaveProperty('d')
  })

  it('verifyAccessToken succeeds for the vendor-signed token against the aggregated jwks', async () => {
    const signer = await buildMultiSigner()
    const jwt = await signer.sign({
      claims: { cls: 6, mode: 'live', scope: {}, psr: 'vendor:x', epoch: 1 },
      iss: 'andpay-auth',
      sub: 'vndr_1',
      aud: VENDOR_PLANE,
      ttlSec: 600,
    })
    const claim = await verifyAccessToken(jwt, {
      jwks: await signer.jwks(),
      expectedIss: 'andpay-auth',
      expectedAud: VENDOR_PLANE,
    })
    expect(claim.sub).toBe('vndr_1')
  })

  it('verifyAccessToken succeeds for the internal-signed token against the aggregated jwks', async () => {
    const signer = await buildMultiSigner()
    const jwt = await signer.sign({
      claims: { cls: 3, mode: 'live', scope: {}, psr: 'role:admin', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 0 },
      iss: 'andpay-auth',
      sub: 'prn_1',
      aud: INTERNAL_ADMIN_PLANE,
      ttlSec: 600,
    })
    const claim = await verifyAccessToken(jwt, {
      jwks: await signer.jwks(),
      expectedIss: 'andpay-auth',
      expectedAud: INTERNAL_ADMIN_PLANE,
    })
    expect(claim.sub).toBe('prn_1')
  })

  it('KID ISOLATION: a vendor token fails verification against a jwks containing only the internal key', async () => {
    const signer = await buildMultiSigner()
    const jwt = await signer.sign({
      claims: { cls: 6, mode: 'live', scope: {}, psr: 'vendor:x', epoch: 1 },
      iss: 'andpay-auth',
      sub: 'vndr_1',
      aud: VENDOR_PLANE,
      ttlSec: 600,
    })
    const internalOnlyAdapter = await LocalEs256Adapter.create('int-1')
    const internalOnlyJwks = await internalOnlyAdapter.jwks()
    await expect(
      verifyAccessToken(jwt, {
        jwks: internalOnlyJwks,
        expectedIss: 'andpay-auth',
        expectedAud: VENDOR_PLANE,
      }),
    ).rejects.toThrow()
  })

  it('D6: an internal token signed by the multi-key signer verifies identically to one signed by the single-key adapter (same key material)', async () => {
    const internalAdapter = await LocalEs256Adapter.create('int-1')
    const vendorAdapter = await LocalEs256Adapter.create('vendor-1')
    const multi = LocalEs256Adapter.createMulti({
      [INTERNAL_ADMIN_PLANE]: internalAdapter,
      [VENDOR_PLANE]: vendorAdapter,
    })

    const now = 1_700_000_000
    const claims = { cls: 3, mode: 'live' as const, scope: {}, psr: 'role:admin', epoch: 1, acr: 'AAL2' as const, amr: ['pwd', 'otp'] as const, auth_time: 0 }

    const jwtFromSingle = await internalAdapter.sign({
      claims,
      iss: 'andpay-auth',
      sub: 'prn_1',
      aud: INTERNAL_ADMIN_PLANE,
      ttlSec: 600,
      now,
    })
    const jwtFromMulti = await multi.sign({
      claims,
      iss: 'andpay-auth',
      sub: 'prn_1',
      aud: INTERNAL_ADMIN_PLANE,
      ttlSec: 600,
      now,
    })

    // Same key material, same deterministic inputs except the jti (random per
    // sign) -> header and payload (minus jti) must be byte-identical.
    const [hSingle, pSingle] = jwtFromSingle.split('.')
    const [hMulti, pMulti] = jwtFromMulti.split('.')
    expect(hMulti).toBe(hSingle)

    const claimsSingle = JSON.parse(Buffer.from(pSingle!, 'base64url').toString('utf8'))
    const claimsMulti = JSON.parse(Buffer.from(pMulti!, 'base64url').toString('utf8'))
    delete claimsSingle.jti
    delete claimsMulti.jti
    expect(claimsMulti).toEqual(claimsSingle)

    // And both verify identically against the single-key adapter's own jwks.
    const claimFromSingle = await verifyAccessToken(jwtFromSingle, {
      jwks: await internalAdapter.jwks(),
      expectedIss: 'andpay-auth',
      expectedAud: INTERNAL_ADMIN_PLANE,
      now,
    })
    const claimFromMulti = await verifyAccessToken(jwtFromMulti, {
      jwks: await internalAdapter.jwks(),
      expectedIss: 'andpay-auth',
      expectedAud: INTERNAL_ADMIN_PLANE,
      now,
    })
    expect(claimFromMulti.sub).toBe(claimFromSingle.sub)
    expect(claimFromMulti.cls).toBe(claimFromSingle.cls)
  })
})
