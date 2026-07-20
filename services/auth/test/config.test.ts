import { describe, it, expect } from 'vitest'
import { validateVendorSet } from '@andpay/authz'
import { ROLES } from '../src/config/roles.js'
import { VENDOR_SETS } from '../src/config/vendor-sets.js'
import { STEP_UP_CATALOG } from '../src/config/step-up-catalog.js'
import { loadConfig } from '../src/config/index.js'

describe('config-as-code (S23, versioned, no runtime control plane)', () => {
  it('class-3 roles carry the 6a assurance floor: super_admin AAL3, others AAL2', () => {
    expect(ROLES.super_admin?.requiredAcr).toBe('AAL3')
    expect(ROLES.admin?.requiredAcr).toBe('AAL2')
    expect(ROLES.ops?.requiredAcr).toBe('AAL2')
    expect(ROLES.support_readonly?.requiredAcr).toBe('AAL2')
  })

  it('super_admin is defined (forward-compatible) at all-programs AAL3', () => {
    expect(ROLES.super_admin?.ceiling).toBe('all-programs')
    expect(ROLES.super_admin?.permissions).toContain('*')
  })

  it('vendor sets are drawn only from the class-6 universe (loaded and validated)', () => {
    expect(Object.keys(VENDOR_SETS)).toContain('vendor_print')
    expect(Object.keys(VENDOR_SETS)).toContain('vendor_manufacturer')
    for (const set of Object.values(VENDOR_SETS)) {
      expect(() => validateVendorSet(set.permissions)).not.toThrow()
    }
  })

  it('rejects a vendor set naming a structurally-excluded permission', () => {
    expect(() => validateVendorSet(['batch:pull-artifacts', 'api_keys:manage'])).toThrow()
  })

  it('the soundbox step-up catalog gates vendor-credential creation and MFA enroll/reset (AAL2, fresh)', () => {
    expect(STEP_UP_CATALOG['vendor_credential:create']?.minAcr).toBe('AAL2')
    expect(STEP_UP_CATALOG['mfa:enroll']?.minAcr).toBe('AAL2')
    expect(STEP_UP_CATALOG['mfa:reset']?.freshnessSec).toBe(300)
  })

  it('loadConfig assembles the RoleConfig the evaluator consumes', () => {
    const cfg = loadConfig()
    expect(cfg.roles.ops?.permissions).toContain('vendor_credential:create')
    expect(cfg.vendorSets.vendor_manufacturer?.permissions).toContain('sheet:submit-intake')
  })
})
