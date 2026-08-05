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

  it.each(['ops', 'admin', 'super_admin'])(
    'permits the full ops permission set for role:%s at an unscoped resource',
    (role) => {
      const cfg = loadOpsConfig()
      expect(authorize(claim(`role:${role}`), 'ops:manual-batch-trigger', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:status-correction', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:upload-bank-file', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:upload-damage-file', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:terminal-override', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:recompose-artifact', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:record-hold', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:record-release', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:vendor-create', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:vendor-suspend', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:vendor-edit', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:resolve-quarantine', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:resolve-intake-exception', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:resolve-status-exception', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:damage-reason-create', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:damage-reason-activate', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:damage-reason-deactivate', {}, cfg).allowed).toBe(true)
      expect(authorize(claim(`role:${role}`), 'ops:update-damage-case', {}, cfg).allowed).toBe(true)
    },
  )

  it('does not resolve support_readonly (no OPS_ROLES entry, unknown-role)', () => {
    const cfg = loadOpsConfig()
    expect(authorize(claim('role:support_readonly'), 'ops:manual-batch-trigger', {}, cfg).allowed).toBe(false)
    expect(authorize(claim('role:support_readonly'), 'ops:status-correction', {}, cfg).allowed).toBe(false)
  })

  // Phase 3 Task 6 (BRD 5.3.2): the FIRST per-role differentiation. The
  // batching-config write is admin-tier: admin / super_admin ONLY, never the
  // baseline ops / ops_portal operator.
  it('ops:batching-config-set is ALLOWED for admin and super_admin only', () => {
    const cfg = loadOpsConfig()
    expect(authorize(claim('role:admin'), 'ops:batching-config-set', {}, cfg).allowed).toBe(true)
    expect(authorize(claim('role:super_admin'), 'ops:batching-config-set', {}, cfg).allowed).toBe(true)
  })

  it('ops:batching-config-set is DENIED for the baseline ops and ops_portal roles (differentiation)', () => {
    const cfg = loadOpsConfig()
    expect(authorize(claim('role:ops'), 'ops:batching-config-set', {}, cfg).allowed).toBe(false)
    expect(authorize(claim('role:ops_portal'), 'ops:batching-config-set', {}, cfg).allowed).toBe(false)
  })

  it('the differentiation is additive: ops still keeps every SHARED ops permission', () => {
    const cfg = loadOpsConfig()
    expect(authorize(claim('role:ops'), 'ops:manual-batch-trigger', {}, cfg).allowed).toBe(true)
    expect(authorize(claim('role:ops'), 'ops:template-config-set', {}, cfg).allowed).toBe(true)
    expect(authorize(claim('role:admin'), 'ops:manual-batch-trigger', {}, cfg).allowed).toBe(true)
  })
})
