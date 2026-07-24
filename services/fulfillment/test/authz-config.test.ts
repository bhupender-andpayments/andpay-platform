import { describe, it, expect } from 'vitest'
import { validateVendorSet } from '@andpay/authz'
import { loadFulfillmentConfig } from '../src/authz-config.js'

describe('fulfillment class-6 authz config (local, C4: never imported from auth)', () => {
  it('vendor_manufacturer submits intake and pulls artifacts (spec 07 two-gate)', () => {
    const cfg = loadFulfillmentConfig()
    expect(cfg.vendorSets.vendor_manufacturer?.permissions).toContain('sheet:submit-intake')
    expect(cfg.vendorSets.vendor_manufacturer?.permissions).toContain('batch:pull-artifacts')
  })

  it('validateVendorSet accepts the manufacturer set (drawn only from the class-6 universe)', () => {
    const cfg = loadFulfillmentConfig()
    expect(() => validateVendorSet(cfg.vendorSets.vendor_manufacturer!.permissions)).not.toThrow()
  })

  it('validateVendorSet accepts the print set', () => {
    const cfg = loadFulfillmentConfig()
    expect(() => validateVendorSet(cfg.vendorSets.vendor_print!.permissions)).not.toThrow()
  })

  it('has no class-3 roles defined (fulfillment authorizes only its vendor two-gate)', () => {
    const cfg = loadFulfillmentConfig()
    expect(cfg.roles).toEqual({})
  })
})
