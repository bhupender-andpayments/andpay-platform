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
validateVendorSet(MANUFACTURER)
validateVendorSet(PRINT)
validateVendorSet(COURIER)

export const VENDOR_SETS: RoleConfig['vendorSets'] = {
  vendor_manufacturer: { permissions: MANUFACTURER },
  vendor_print: { permissions: PRINT },
  vendor_courier: { permissions: COURIER },
}
