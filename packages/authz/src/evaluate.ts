import type { LeanClaim, Acr } from './claims.js'
import { AuthzError } from './errors.js'

// The complete class-6 permission universe (105d). A vendor permission set may
// contain ONLY these operations, capped to the vendor's own batches. Money and
// M4 (unrepresentable for an external principal, 5f), KYC attestation (K3),
// posture/elevation controls, api_keys:manage, and any activation authority
// (TMS) are STRUCTURALLY outside this universe, not merely ungranted.
// Single-sourced: the array is the one place the universe is enumerated;
// the type and the runtime Set are both derived from it, so they cannot drift.
export const CLASS_SIX_PERMISSIONS = [
  'batch:pull-artifacts',
  'sheet:submit-intake',
  'sheet:submit-return',
  // spec 09: the courier submits carrier status for its own shipments. No
  // artifact pull, so this set is strictly narrower than the print vendor's.
  'shipment:submit-status',
] as const

export type ClassSixPermission = (typeof CLASS_SIX_PERMISSIONS)[number]

const CLASS_SIX_UNIVERSE: ReadonlySet<string> = new Set<ClassSixPermission>(CLASS_SIX_PERMISSIONS)

// The scope ceiling is a maximum reach resolved from the role (4c), never a
// standing grant floor.
export type ScopeCeiling = 'all-programs' | 'own-tenant' | 'own-program'

// Phantom brand: never present at runtime (a `declare const`, never
// assigned), so it costs nothing and JSON.stringify/property reads on a
// HumanRole are unaffected. Its only job is to make a class-6 permission
// structurally unrepresentable in RoleConfig.roles (5f/S14: "a type
// separation, not a convention"): the brand can only be attached by
// `humanRole()`, so a plain role literal (bypassing the builder) is rejected
// by the type checker, not merely by the runtime guard in `authorizeHuman`.
declare const HUMAN_ROLE_BRAND: unique symbol
export interface HumanRole {
  permissions: string[]
  ceiling: ScopeCeiling
  requiredAcr: Acr
  readonly [HUMAN_ROLE_BRAND]: true
}

export interface RoleConfig {
  // Class-3 human roles to their permission set, ceiling, and required AAL
  // (6a). Only `humanRole()` can produce a HumanRole (branded), so a class-6
  // permission is unrepresentable here except by going through the builder,
  // which itself rejects class-6 literals at the call site (HumanRoleInput).
  roles: Record<string, HumanRole>
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
  return claim.cls === 6 || claim.cls === 7
    ? authorizeVendor(claim, operation, resource, cfg, { enforceWorkQueue: claim.cls === 6 })
    : authorizeHuman(claim, operation, resource, cfg)
}

// A human role's permissions must not contain any class-6 vendor permission.
// P is inferred naked (const) so it stays inferrable; the intersection adds an
// incompatible constraint on `permissions` iff P contains a ClassSixPermission,
// producing a compile error there. The corpus defines no closed human
// permission set, so human strings stay open; only the class-6 literals are
// rejected (unrepresentable, S14/S16).
type HumanRoleInput<P extends readonly string[]> = {
  permissions: P
  ceiling: ScopeCeiling
  requiredAcr: Acr
} & (Extract<P[number], ClassSixPermission> extends never
  ? unknown
  : { permissions: ['a class-6 permission is not allowed in a human role'] })

export function humanRole<const P extends readonly string[]>(role: HumanRoleInput<P>): HumanRole {
  return {
    permissions: role.permissions as unknown as string[],
    ceiling: role.ceiling,
    requiredAcr: role.requiredAcr,
  } as HumanRole
}

export function authorizeHuman(claim: LeanClaim, operation: string, resource: AuthzResource, cfg: RoleConfig): AuthzDecision {
  // Defense-in-depth (D6): a class-6 vendor permission must never be
  // evaluated in the human branch, even if `operation` was widened to
  // `string` or cast through `any` before reaching here.
  if (CLASS_SIX_UNIVERSE.has(operation)) return { allowed: false, reason: 'class6-in-human-context' }
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

// Parameterized to serve both class 6 (vendor systems) and class 7
// (vendor-operator humans, D122). The work-queue check is an explicit
// opt-in, defaulted to true so every pre-existing class-6 call site (none of
// which pass opts) is byte-behavior-unchanged. Class 7 carries scope.vndr
// only and skips the work-queue axis (Fork C); the vendor-id isolation axis
// stays enforced for both classes.
export function authorizeVendor(
  claim: LeanClaim,
  operation: string,
  resource: AuthzResource,
  cfg: RoleConfig,
  opts: { enforceWorkQueue?: boolean } = {},
): AuthzDecision {
  const enforceWorkQueue = opts.enforceWorkQueue ?? true
  const set = cfg.vendorSets[stripPrefix(claim.psr, 'vset:')]
  if (!set) return { allowed: false, reason: 'unknown-vendor-set' }
  if (!set.permissions.includes(operation as ClassSixPermission)) {
    return { allowed: false, reason: 'permission-denied' }
  }
  // The vendor may act only on its own vendor id (105c), always enforced.
  if (resource.vndrId !== claim.scope.vndr) {
    return { allowed: false, reason: 'scope-denied' }
  }
  // The work-queue axis is enforced only for class-6 machine calls.
  if (enforceWorkQueue && resource.workQueue !== claim.scope.wq) {
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
