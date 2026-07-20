import type { LeanClaim, Acr } from './claims.js'
import { AuthzError } from './errors.js'

// The complete class-6 permission universe (105d). A vendor permission set may
// contain ONLY these operations, capped to the vendor's own batches. Money and
// M4 (unrepresentable for an external principal, 5f), KYC attestation (K3),
// posture/elevation controls, api_keys:manage, and any activation authority
// (TMS) are STRUCTURALLY outside this universe, not merely ungranted.
export type ClassSixPermission = 'batch:pull-artifacts' | 'sheet:submit-intake' | 'sheet:submit-return'

const CLASS_SIX_UNIVERSE: ReadonlySet<string> = new Set<ClassSixPermission>([
  'batch:pull-artifacts',
  'sheet:submit-intake',
  'sheet:submit-return',
])

// The scope ceiling is a maximum reach resolved from the role (4c), never a
// standing grant floor.
export type ScopeCeiling = 'all-programs' | 'own-tenant' | 'own-program'

export interface RoleConfig {
  // Class-3 human roles to their permission set, ceiling, and required AAL (6a).
  roles: Record<string, { permissions: string[]; ceiling: ScopeCeiling; requiredAcr: Acr }>
  // Class-6 vendor sets; permissions validated against the universe at load.
  vendorSets: Record<string, { permissions: ClassSixPermission[] }>
}

export interface AuthzResource {
  programId?: string
  vndrId?: string
  workQueue?: string
}

export interface AuthzDecision {
  allowed: boolean
  reason?: string
}

// Reject a vendor permission set that names anything outside the class-6
// universe (105d). This is where "an attempt to grant one is rejected, not
// silently ungranted" is enforced, at config-load time.
export function validateVendorSet(perms: readonly string[]): asserts perms is ClassSixPermission[] {
  for (const p of perms) {
    if (!CLASS_SIX_UNIVERSE.has(p)) {
      throw new AuthzError('permission-not-in-class6-universe', p)
    }
  }
}

// The Decision-2 two-gate evaluation: permission (RBAC, which operations) AND
// scope (ABAC, which resources), both ANDed and evaluated LOCALLY (T4, 16.2). A
// missing permission denies the operation; a scope miss denies the resource.
export function authorize(claim: LeanClaim, operation: string, resource: AuthzResource, cfg: RoleConfig): AuthzDecision {
  return claim.cls === 6
    ? authorizeClassSix(claim, operation, resource, cfg)
    : authorizeHuman(claim, operation, resource, cfg)
}

function authorizeHuman(claim: LeanClaim, operation: string, resource: AuthzResource, cfg: RoleConfig): AuthzDecision {
  const role = cfg.roles[stripPrefix(claim.psr, 'role:')]
  if (!role) return { allowed: false, reason: 'unknown-role' }
  if (!role.permissions.includes('*') && !role.permissions.includes(operation)) {
    return { allowed: false, reason: 'permission-denied' }
  }
  if (!withinCeiling(claim, resource, role.ceiling)) {
    return { allowed: false, reason: 'scope-denied' }
  }
  return { allowed: true }
}

function authorizeClassSix(claim: LeanClaim, operation: string, resource: AuthzResource, cfg: RoleConfig): AuthzDecision {
  const set = cfg.vendorSets[stripPrefix(claim.psr, 'vset:')]
  if (!set) return { allowed: false, reason: 'unknown-vendor-set' }
  if (!set.permissions.includes(operation as ClassSixPermission)) {
    return { allowed: false, reason: 'permission-denied' }
  }
  // The vendor may act only on its own vendor id and work queue (105c).
  if (resource.vndrId !== claim.scope.vndr || resource.workQueue !== claim.scope.wq) {
    return { allowed: false, reason: 'scope-denied' }
  }
  return { allowed: true }
}

// The ceiling caps reach: a resource naming no program is unscoped and passes;
// all-programs always passes; own-tenant/own-program require the program to be
// present in the principal's scope (empty for class 3 in this slice, so a
// program-scoped resource would be denied until the Identity fact-read seam is
// wired at Identity-min).
function withinCeiling(claim: LeanClaim, resource: AuthzResource, ceiling: ScopeCeiling): boolean {
  if (resource.programId === undefined) return true
  if (ceiling === 'all-programs') return true
  return (claim.scope.pids ?? []).includes(resource.programId)
}

function stripPrefix(psr: string, prefix: string): string {
  return psr.startsWith(prefix) ? psr.slice(prefix.length) : psr
}
