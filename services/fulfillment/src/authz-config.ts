import { validateVendorSet, type RoleConfig, type ClassSixPermission } from '@andpay/authz'

// Local class-6 vendor sets (config-as-code, C4: fulfillment declares its own,
// never imports services/auth's). Manufacturer submits intake + pulls artifacts.
const MANUFACTURER: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-intake']
const PRINT: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-return']
// Courier submits carrier status only. NO artifact pull (105d), narrower than
// the print vendor.
const COURIER: ClassSixPermission[] = ['shipment:submit-status']
// Spec 14a (D122) task 13: class 7 is a SINGLE external human role, "vendor
// operator", authenticated via a verified JWT (never apsk_). Local to this
// context (C4, same reasoning as MANUFACTURER/PRINT/COURIER above: never
// imported from services/auth's own vendor-sets.ts, which mints the matching
// `vset:vendor_operator` psr literal). Batch pull plus both sheet
// submissions, but NOT shipment:submit-status (that carrier-status path stays
// class-6/COURIER-only, 105d).
// Spec 14b: adds batch:read, the vendor-portal work-queue/history READ
// capability. Kept in parity with services/auth/src/config/vendor-sets.ts's
// copy (guarded by test/vendor-operator-set-parity.test.ts).
const VENDOR_OPERATOR: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-intake', 'sheet:submit-return', 'batch:read']

// Validated at module load: naming an excluded permission throws here, not
// silently ungranted (105d). This is the config-load enforcement point.
validateVendorSet(MANUFACTURER)
validateVendorSet(PRINT)
validateVendorSet(COURIER)
validateVendorSet(VENDOR_OPERATOR)

export function loadFulfillmentConfig(): RoleConfig {
  return {
    roles: {},
    vendorSets: {
      vendor_manufacturer: { permissions: MANUFACTURER },
      vendor_print: { permissions: PRINT },
      vendor_courier: { permissions: COURIER },
      // The literal key MUST match the `vset:vendor_operator` psr minted by
      // services/auth/src/vendor-login.ts's VENDOR_OPERATOR_SET_NAME
      // ('vendor_operator'); duplicated here rather than imported, per C4.
      vendor_operator: { permissions: VENDOR_OPERATOR },
    },
  }
}
