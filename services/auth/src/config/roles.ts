import { humanRole, type RoleConfig } from '@andpay/authz'
import { resolveSuperAdminAcr } from './assurance-config.js'

// Class-3 role to permission-set and scope-ceiling mapping (D2, 16.1, 4c),
// config-as-code and CODEOWNERS-gated (S23), resolved LOCALLY at evaluation
// (T4). Roles match the 16.1 sub-roles (support/read, ops, admin, super-admin).
// The required assurance level (6a) is the floor a principal in the role must
// reach: AAL2 for the human floor, AAL3 for super-admin.
//
// super_admin is DEFINED for forward compatibility but no super_admin principal
// is provisioned in v1, and its AAL3 requirement plus the WebAuthn deferral gate
// its login closed (the soundbox needs no all-tenant super-admin: no posture
// rail, no M4, no multi-tenant portal). v1's top operating role is admin (AAL2).
export const ROLES: RoleConfig['roles'] = {
  support_readonly: humanRole({
    permissions: ['principal:read'],
    ceiling: 'own-program',
    requiredAcr: 'AAL2',
  }),
  ops: humanRole({
    permissions: ['principal:read', 'vendor_credential:create', 'vendor_credential:revoke'],
    ceiling: 'own-program',
    requiredAcr: 'AAL2',
  }),
  admin: humanRole({
    permissions: ['principal:read', 'vendor_credential:create', 'vendor_credential:revoke', 'mfa:enroll', 'mfa:reset'],
    ceiling: 'own-tenant',
    requiredAcr: 'AAL2',
  }),
  super_admin: humanRole({
    permissions: ['*'],
    ceiling: 'all-programs',
    requiredAcr: resolveSuperAdminAcr(),
  }),
}
