import { validateVendorSet, type RoleConfig, type ClassSixPermission } from '@andpay/authz'

// Local class-6 vendor sets (config-as-code, C4: fulfillment declares its own,
// never imports services/auth's). Manufacturer submits intake + pulls artifacts.
const MANUFACTURER: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-intake']
const PRINT: ClassSixPermission[] = ['batch:pull-artifacts', 'sheet:submit-return']

// Validated at module load: naming an excluded permission throws here, not
// silently ungranted (105d). This is the config-load enforcement point.
validateVendorSet(MANUFACTURER)
validateVendorSet(PRINT)

export function loadFulfillmentConfig(): RoleConfig {
  return { roles: {}, vendorSets: { vendor_manufacturer: { permissions: MANUFACTURER }, vendor_print: { permissions: PRINT } } }
}
