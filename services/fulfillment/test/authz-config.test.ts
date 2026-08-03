import { describe, it, expect } from 'vitest'
import { authorize, validateVendorSet } from '@andpay/authz'
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

  it('the courier vendor set has status submit and NO artifact pull (105d)', () => {
    const sets = loadFulfillmentConfig().vendorSets
    expect(sets.vendor_courier).toBeTruthy()
    expect(sets.vendor_courier!.permissions).toEqual(['shipment:submit-status'])
    expect(sets.vendor_courier!.permissions).not.toContain('batch:pull-artifacts')
  })

  it('the courier set structurally excludes money, KYC, posture, api_keys and activation (105d)', () => {
    for (const p of ['ledger:post', 'kyc:read', 'posture:elevate', 'api_keys:manage', 'device:activate']) {
      expect(() => validateVendorSet([p])).toThrow()
    }
  })

  it('the real vendor_operator config authorizes a class-7 batch:read on own vndr (spec 14b)', () => {
    const claim = { sub: 'op1', cls: 7 as const, mode: 'live' as const, scope: { vndr: 'vndr_abc' }, psr: 'vset:vendor_operator', aud: 'andpay:vendor', acr: 'aal2', amr: ['pwd', 'otp'] }
    const d = authorize(claim as never, 'batch:read', { vndrId: 'vndr_abc' }, loadFulfillmentConfig())
    expect(d.allowed).toBe(true)
  })
})
