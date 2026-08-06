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
  // First-login TOTP self-enrollment (Bhupender ruling 2026-08-06). NOT a
  // principal's assigned role: it is the psr stamped on the short-lived,
  // single-purpose token that login mints when a principal authenticates by
  // password and has NO active enrollment yet. It carries exactly ONE
  // permission, so a token bearing it can reach the enrollment route and
  // nothing else, and its AAL1 floor is what lets a password-only holder
  // reach that one route. Every ops permission is denied by omission rather
  // than by a special case.
  //
  // The takeover path this could open (rebinding an EXISTING authenticator
  // with a password alone) is closed in enrollTotp, which refuses when an
  // active enrollment already exists for a self-enrollment caller. Re-binding
  // stays on the admin plus step-up path.
  enrollment_pending: humanRole({
    permissions: ['mfa:enroll'],
    ceiling: 'own-program',
    requiredAcr: 'AAL1',
  }),
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
