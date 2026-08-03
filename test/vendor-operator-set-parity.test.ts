import { describe, it, expect } from 'vitest'
import { VENDOR_SETS, VENDOR_OPERATOR_SET_NAME } from '@andpay/auth-service'
import { loadFulfillmentConfig } from '@andpay/fulfillment-service'

// Spec 14a (D122) drift guard: the class-7 vendor_operator permission set is
// DUPLICATED, by C4 design, across two contexts that must never import each
// other:
//   - MINT side:   services/auth/src/config/vendor-sets.ts (VENDOR_SETS,
//                  used by the vendor-login psr, keyed by VENDOR_OPERATOR_SET_NAME)
//   - VERIFY side: services/fulfillment/src/authz-config.ts
//                  (loadFulfillmentConfig().vendorSets.vendor_operator,
//                  used by the vendor-edge authorize call)
//
// validateVendorSet only proves each copy is within the CLASS_SIX_PERMISSIONS
// universe; it says nothing about the two copies agreeing with EACH OTHER. If
// someone edits one file and not the other (e.g. adds a permission to the
// mint side only), a token minted with the wider set would be authorized
// against the narrower verify-side set (or vice versa): a silent mint<->verify
// contract break that no single-context test can catch. This root-level test
// (not inside services/auth or services/fulfillment, so importing from both
// is not a C4 cross-context violation, matching audience_isolation_cross_edge)
// is the cross-cutting proof that the two copies are, right now, identical.
describe('class-7 vendor_operator set parity (spec 14a): mint (auth) vs verify (fulfillment)', () => {
  it('both sides key the set under the SAME literal name, "vendor_operator"', () => {
    expect(VENDOR_OPERATOR_SET_NAME).toBe('vendor_operator')

    const fulfillmentVendorSetKeys = Object.keys(loadFulfillmentConfig().vendorSets)
    expect(fulfillmentVendorSetKeys).toContain(VENDOR_OPERATOR_SET_NAME)
  })

  it('the auth-side (mint) VENDOR_OPERATOR permissions equal the fulfillment-side (verify) vendor_operator permissions', () => {
    const mintSet = VENDOR_SETS[VENDOR_OPERATOR_SET_NAME]
    const verifySet = loadFulfillmentConfig().vendorSets['vendor_operator']

    expect(mintSet, 'auth-side VENDOR_SETS must carry the vendor_operator entry').toBeDefined()
    expect(verifySet, 'fulfillment-side vendorSets must carry the vendor_operator entry').toBeDefined()

    const mintPermissions = mintSet!.permissions
    const verifyPermissions = verifySet!.permissions

    // Order-insensitive equality, so the two copies cannot silently diverge in
    // membership. If either file gains, drops, or swaps a permission without
    // the matching edit on the other side, this fails.
    expect([...mintPermissions].sort()).toEqual([...verifyPermissions].sort())

    // Pin the expected membership explicitly too, so a drift that happens to
    // change BOTH sides identically (e.g. both accidentally trimmed to the
    // same wrong 2-element set) still fails against the known-correct set,
    // rather than only proving the two sides agree with each other.
    expect([...mintPermissions].sort()).toEqual(['batch:pull-artifacts', 'sheet:submit-intake', 'sheet:submit-return', 'batch:read'].sort())
  })
})
