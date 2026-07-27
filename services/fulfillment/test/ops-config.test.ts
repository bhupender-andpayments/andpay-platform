import { describe, it, expect } from 'vitest'
import { authorize, type LeanClaim } from '@andpay/authz'
import { loadOpsConfig } from '@andpay/fulfillment-service'

const claim = (psr: string, acr: 'AAL1' | 'AAL2' = 'AAL2'): LeanClaim => ({
  iss: 'i', sub: 's', aud: 'andpay:internal-admin', iat: 1, exp: 9, nbf: 0, jti: 'j',
  cls: 3, mode: 'live', scope: {}, psr, epoch: 1, acr, amr: ['pwd', 'otp'], auth_time: 1,
})

describe('class-3 ops RoleConfig', () => {
  it('permits the ops operations for role:ops_portal at an unscoped resource', () => {
    const cfg = loadOpsConfig()
    expect(authorize(claim('role:ops_portal'), 'ops:manual-batch-trigger', {}, cfg).allowed).toBe(true)
    expect(authorize(claim('role:ops_portal'), 'ops:status-correction', {}, cfg).allowed).toBe(true)
  })
  it('denies an unknown role and an unknown operation', () => {
    const cfg = loadOpsConfig()
    expect(authorize(claim('role:nobody'), 'ops:manual-batch-trigger', {}, cfg).allowed).toBe(false)
    expect(authorize(claim('role:ops_portal'), 'ops:not-a-thing', {}, cfg).allowed).toBe(false)
  })
})
