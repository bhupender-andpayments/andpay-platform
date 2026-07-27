import { describe, it, expect, beforeAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type KeyLike } from 'jose'
import { resolveClaimFromAuthHeader, EdgeAuthError, type CredentialProjectionRow } from '../src/index.js'

// The ONLY external interaction exercised anywhere in this file is the
// injected `lookup` function below (a plain in-memory Map read). There is no
// network call, no DB client, no import of @andpay/auth-service or
// services/auth: resolution is entirely local (T4/S14/5e).

const pepper = 'dev-pepper-not-a-real-secret'
const secret = 'apsk_test_courier1SUFFIXabcdefghijklmno'

const row: CredentialProjectionRow = {
  apiId: 'api_x',
  vndrId: 'vndr_c1',
  workQueue: 'courier-status',
  permissionSetRef: 'vset:vendor_courier',
  mode: 'test',
  status: 'ACTIVE',
  epoch: 1,
}

const pepperedHash = createHmac('sha256', pepper).update(secret).digest('hex')
const map = new Map([[pepperedHash, row]])
const lookup = (h: string): CredentialProjectionRow | undefined => map.get(h)

describe('resolveClaimFromAuthHeader (edge local-verify, apsk_ branch)', () => {
  it('resolves an apsk_ secret to a cls:6 lean claim with no acr/amr', async () => {
    const claim = await resolveClaimFromAuthHeader('Bearer ' + secret, {
      pepper,
      lookup,
      expectedPlane: 'andpay:vendor',
      expectedMode: 'test',
    })
    expect(claim.cls).toBe(6)
    expect(claim.scope.vndr).toBe('vndr_c1')
    expect(claim.scope.wq).toBe('courier-status')
    expect(claim.psr).toBe('vset:vendor_courier')
    expect(claim.aud).toBe('andpay:vendor')
    expect(claim.acr).toBeUndefined()
    expect(claim.amr).toBeUndefined()
  })

  it('fails closed on a REVOKED row', async () => {
    const revokedMap = new Map([[pepperedHash, { ...row, status: 'REVOKED' as const }]])
    await expect(
      resolveClaimFromAuthHeader('Bearer ' + secret, {
        pepper,
        lookup: (h) => revokedMap.get(h),
        expectedPlane: 'andpay:vendor',
        expectedMode: 'test',
      }),
    ).rejects.toThrow()
  })

  it('throws EdgeAuthError missing-credential on a missing header', async () => {
    await expect(
      resolveClaimFromAuthHeader(undefined, {
        pepper,
        lookup,
        expectedPlane: 'andpay:vendor',
        expectedMode: 'test',
      }),
    ).rejects.toMatchObject({ code: 'missing-credential' })
  })

  it('throws EdgeAuthError malformed-authorization on a non-Bearer header', async () => {
    await expect(
      resolveClaimFromAuthHeader('Basic ' + secret, {
        pepper,
        lookup,
        expectedPlane: 'andpay:vendor',
        expectedMode: 'test',
      }),
    ).rejects.toMatchObject({ code: 'malformed-authorization' })
  })

  it('rejects the SAME apsk_ secret resolved against the internal-admin plane (class6-wrong-plane)', async () => {
    await expect(
      resolveClaimFromAuthHeader('Bearer ' + secret, {
        pepper,
        lookup,
        expectedPlane: 'andpay:internal-admin',
        expectedMode: 'test',
      }),
    ).rejects.toMatchObject({ code: 'class6-wrong-plane' })
  })

  it('rejects a JWT-shaped token on an edge with no jwks wired (jwt-not-supported-on-this-edge)', async () => {
    const jwtShaped = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'
    await expect(
      resolveClaimFromAuthHeader('Bearer ' + jwtShaped, {
        pepper,
        lookup,
        expectedPlane: 'andpay:vendor',
        expectedMode: 'test',
      }),
    ).rejects.toMatchObject({ code: 'jwt-not-supported-on-this-edge' })
  })

  it('EdgeAuthError instances carry the .code property and are real Errors', async () => {
    try {
      await resolveClaimFromAuthHeader(undefined, {
        pepper,
        lookup,
        expectedPlane: 'andpay:vendor',
        expectedMode: 'test',
      })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EdgeAuthError)
      expect(err).toBeInstanceOf(Error)
      // Never a partial claim, never the secret, anywhere in the error.
      expect(JSON.stringify(err)).not.toContain(secret)
      expect(String((err as Error).message)).not.toContain(secret)
    }
  })
})

describe('resolveClaimFromAuthHeader (edge local-verify, JWT branch mode gate, S16 carry-forward)', () => {
  let jwtJwks: JSONWebKeySet
  let jwtPriv: KeyLike
  const jwtIss = 'andpay-auth'

  async function mintJwt(mode: 'live' | 'test'): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    return await new SignJWT({
      cls: 2,
      mode,
      scope: {},
      psr: 'role:tenant-viewer',
      epoch: 1,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'dev-1', typ: 'at+jwt' })
      .setIssuer(jwtIss)
      .setAudience('andpay:tenant-portal')
      .setSubject('prn_tenant_1')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 600)
      .setJti('jti_tenant_1')
      .sign(jwtPriv)
  }

  beforeAll(async () => {
    const kp = await generateKeyPair('ES256', { extractable: true })
    jwtPriv = kp.privateKey
    const pub = await exportJWK(kp.publicKey)
    jwtJwks = { keys: [{ ...pub, kid: 'dev-1', alg: 'ES256', use: 'sig' }] }
  })

  it('rejects a mode:test JWT on an edge expecting live (S16 mode gate)', async () => {
    const jwt = await mintJwt('test')
    await expect(
      resolveClaimFromAuthHeader('Bearer ' + jwt, {
        pepper: 'x',
        lookup: () => undefined,
        jwks: jwtJwks,
        expectedIss: jwtIss,
        expectedPlane: 'andpay:tenant-portal',
        expectedMode: 'live',
      }),
    ).rejects.toMatchObject({ code: 'mode-mismatch' })
  })

  it('resolves a mode:live JWT on an edge expecting live to a cls:2 claim', async () => {
    const jwt = await mintJwt('live')
    const claim = await resolveClaimFromAuthHeader('Bearer ' + jwt, {
      pepper: 'x',
      lookup: () => undefined,
      jwks: jwtJwks,
      expectedIss: jwtIss,
      expectedPlane: 'andpay:tenant-portal',
      expectedMode: 'live',
    })
    expect(claim.cls).toBe(2)
    expect(claim.mode).toBe('live')
  })
})
