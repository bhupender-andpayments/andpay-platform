import { validateVendorSet, type RoleConfig, type ClassSixPermission } from '@andpay/authz'

// Class-6 vendor permission sets (105d). Different vendor roles are different
// permission sets on the same class. Each is capped to pulling its own assigned
// batch artifacts and submitting its own sheets. Money, KYC attestation,
// posture, api_keys:manage, and activation are STRUCTURALLY outside the class-6
// universe and cannot be named here.
const MANUFACTURER: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-intake']
const PRINT: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-return']
// Courier submits carrier status only. NO artifact pull (105d), narrower than
// the print vendor.
const COURIER: ClassSixPermission[] = ['shipment:submit-status']

// Validated at module load: naming an excluded permission throws here, not
// silently ungranted (105d). This is the config-load enforcement point.
// Spec 14a (D122): class 7 is a SINGLE external human role, "vendor operator",
// AAL2 (Field 8). It is a separate universe from the class-6 machine sets
// above: batch pull + both sheet submissions, but NOT shipment:submit-status
// (that carrier-status path stays class-6/COURIER-only). All class-7
// operators reference this one set in v1 (the vendor_operator row carries no
// role column, Task 3/4).
const VENDOR_OPERATOR: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-intake', 'sheet:submit-return']

validateVendorSet(MANUFACTURER)
validateVendorSet(PRINT)
validateVendorSet(COURIER)
validateVendorSet(VENDOR_OPERATOR)

// The class-7 vendorSet name minted into the psr claim as `vset:<name>`
// (vendor-login.ts). Exported as a named constant so the login flow and this
// config never drift on the literal string.
export const VENDOR_OPERATOR_SET_NAME = 'vendor_operator' as const

export const VENDOR_SETS: RoleConfig['vendorSets'] = {
  vendor_manufacturer: { permissions: MANUFACTURER },
  vendor_print: { permissions: PRINT },
  vendor_courier: { permissions: COURIER },
  [VENDOR_OPERATOR_SET_NAME]: { permissions: VENDOR_OPERATOR },
}
