import { describe, it, expect } from 'vitest'
import { meetsAcr, requireStepUp, OPS_STEP_UP_CATALOG, AuthzError, type LeanClaim } from '../src/index.js'

const base: LeanClaim = {
  iss: 'i', sub: 's', aud: 'andpay:internal-admin', iat: 1000, exp: 9999, nbf: 0, jti: 'j',
  cls: 3, mode: 'live', scope: {}, psr: 'role:ops', epoch: 1, acr: 'AAL2', amr: ['pwd', 'otp'], auth_time: 1000,
}

describe('step-up single-sourced in @andpay/authz', () => {
  it('meetsAcr ranks AAL1<AAL2<AAL3', () => {
    expect(meetsAcr('AAL2', 'AAL2')).toBe(true)
    expect(meetsAcr('AAL1', 'AAL2')).toBe(false)
    expect(meetsAcr('AAL3', 'AAL2')).toBe(true)
  })
  it('rejects insufficient acr', () => {
    expect(() => requireStepUp({ ...base, acr: 'AAL1' }, OPS_STEP_UP_CATALOG['terminal-override']!, 1000)).toThrow(AuthzError)
  })
  it('rejects stale auth_time against freshnessSec', () => {
    expect(() => requireStepUp({ ...base, auth_time: 0 }, OPS_STEP_UP_CATALOG['vendor-suspend']!, 100000)).toThrow(/stale-auth-time/)
  })
  it('passes a fresh, sufficient claim', () => {
    // Was OPS_STEP_UP_CATALOG['hold-release'] until 19 Aug 2026, when that
    // entry was removed (see stepup.ts). Any remaining entry exercises the same
    // requireStepUp branch; terminal-override is the one this file already uses
    // above.
    expect(() => requireStepUp(base, OPS_STEP_UP_CATALOG['terminal-override']!, 1100)).not.toThrow()
  })
})
