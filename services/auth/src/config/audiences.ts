import type { Plane } from '@andpay/authz'

// One distinct audience per plane (16.3 point 6, 105f). The auth slice serves
// two: the internal-admin plane (class-3 human JWTs) and the vendor plane
// (class-6 credentials, checked at resolution, never minted as a JWT). The
// remaining planes are reserved for later specs.
export const INTERNAL_ADMIN_PLANE: Plane = 'andpay:internal-admin'
export const VENDOR_PLANE: Plane = 'andpay:vendor'
