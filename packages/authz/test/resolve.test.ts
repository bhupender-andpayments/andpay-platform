import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { resolveEdgeCredential, isDenylisted, type CredentialProjectionRow } from '../src/index.js'

const pepper = 'dev-pepper-not-a-real-secret'
const secret = 'apsk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567abcdef'
const hashOf = (s: string): string => createHmac('sha256', pepper).update(s).digest('hex')

const row: CredentialProjectionRow = {
  apiId: 'api_1',
  vndrId: 'vndr_1',
  workQueue: 'wq-A',
  permissionSetRef: 'vset:vendor_print',
  mode: 'live',
  status: 'ACTIVE',
  epoch: 1,
}
const lookup = (h: string): CredentialProjectionRow | undefined => (h === hashOf(secret) ? row : undefined)

describe('resolveEdgeCredential (5c storage, 5e fail-closed resolution)', () => {
  it('resolves a live secret to the uniform lean claim (cls 6, no acr per 5f)', () => {
    const c = resolveEdgeCredential(secret, { pepper, lookup, expectedPlane: 'andpay:vendor', expectedMode: 'live' })
    expect(c.cls).toBe(6)
    expect(c.aud).toBe('andpay:vendor')
    expect(c.scope.vndr).toBe('vndr_1')
    expect(c.scope.wq).toBe('wq-A')
    expect(c.psr).toBe('vset:vendor_print')
    expect(c.mode).toBe('live')
    expect(c.acr).toBeUndefined()
    expect(c.sub).toBe('api_1')
  })

  it('fails closed on an unknown secret', () => {
    expect(() =>
      resolveEdgeCredential('apsk_live_UNKNOWNSECRETVALUE0000000000000000', {
        pepper, lookup, expectedPlane: 'andpay:vendor', expectedMode: 'live',
      }),
    ).toThrow()
  })

  it('rejects a live secret on a test-plane edge (mode mismatch, 5b/5e)', () => {
    expect(() =>
      resolveEdgeCredential(secret, { pepper, lookup, expectedPlane: 'andpay:vendor', expectedMode: 'test' }),
    ).toThrow()
  })

  it('rejects a REVOKED credential (5d status revoke)', () => {
    const revokedLookup = (h: string): CredentialProjectionRow | undefined =>
      h === hashOf(secret) ? { ...row, status: 'REVOKED' } : undefined
    expect(() =>
      resolveEdgeCredential(secret, { pepper, lookup: revokedLookup, expectedPlane: 'andpay:vendor', expectedMode: 'live' }),
    ).toThrow()
  })

  it('rejects an expired credential', () => {
    const expiredLookup = (h: string): CredentialProjectionRow | undefined =>
      h === hashOf(secret) ? { ...row, expiresAt: 1 } : undefined
    expect(() =>
      resolveEdgeCredential(secret, { pepper, lookup: expiredLookup, expectedPlane: 'andpay:vendor', expectedMode: 'live', now: 1000 }),
    ).toThrow()
  })

  it('denylist kills a valid credential immediately (D3)', () => {
    expect(() =>
      resolveEdgeCredential(secret, {
        pepper, lookup, denylist: new Set(['api_1']), expectedPlane: 'andpay:vendor', expectedMode: 'live',
      }),
    ).toThrow()
  })

  it('isDenylisted checks membership', () => {
    expect(isDenylisted('api_1', new Set(['api_1']))).toBe(true)
    expect(isDenylisted('api_2', new Set(['api_1']))).toBe(false)
    expect(isDenylisted('api_1', undefined)).toBe(false)
  })
})
