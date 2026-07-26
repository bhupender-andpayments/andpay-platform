import { humanRole, type RoleConfig } from '../src/index.js'

// Positive: open human strings are accepted (no closed human set).
humanRole({ permissions: ['vendor_credential:create', 'mfa:reset', '*'], ceiling: 'own-program', requiredAcr: 'AAL2' })

// @ts-expect-error a class-6 permission is UNREPRESENTABLE in a human role.
humanRole({ permissions: ['shipment:submit-status'], ceiling: 'all-programs', requiredAcr: 'AAL3' })

// @ts-expect-error every class-6 literal is rejected (batch:pull-artifacts too).
humanRole({ permissions: ['batch:pull-artifacts'], ceiling: 'own-program', requiredAcr: 'AAL2' })

// @ts-expect-error a class-6 literal mixed with open human strings is still rejected.
humanRole({ permissions: ['vendor_credential:create', 'sheet:submit-intake'], ceiling: 'own-program', requiredAcr: 'AAL2' })

// @ts-expect-error sheet:submit-return is also rejected.
humanRole({ permissions: ['sheet:submit-return'], ceiling: 'own-program', requiredAcr: 'AAL2' })

// Structural proof (not merely a convention): a plain RoleConfig role literal
// is rejected, because a HumanRole cannot be built without going through
// humanRole() (brand required). This is what makes a class-6 permission
// unrepresentable in RoleConfig.roles, not just rejected at one call site.
// @ts-expect-error a human role cannot be built without humanRole() (brand required), so a class-6 permission is structurally unrepresentable in RoleConfig.roles.
const _bad: RoleConfig = { roles: { r: { permissions: ['shipment:submit-status'], ceiling: 'all-programs', requiredAcr: 'AAL2' } }, vendorSets: {} }
void _bad

// Positive structural proof: a humanRole()-built role IS assignable to RoleConfig.roles.
const _ok: RoleConfig = { roles: { r: humanRole({ permissions: ['vendor_credential:create'], ceiling: 'own-program', requiredAcr: 'AAL2' }) }, vendorSets: {} }
void _ok
