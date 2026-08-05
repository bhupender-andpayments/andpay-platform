import { humanRole, type RoleConfig } from '@andpay/authz'

// The class-3 ops portal role (S15, D2, 4c), config-as-code, CODEOWNERS-gated
// (S23), resolved LOCALLY at the edge (T4). Ceiling is 'all-programs': the ops
// team is the platform operator (D69 class 3); per-action scoping is enforced at
// the DB write-gate via SET LOCAL app.program_id (server-resolved), not by the
// claim scope, and the destructive actions carry an additional step-up gate.
// requiredAcr is the AAL2 human floor (S15); Auth mints only tokens that meet it.
// Fix wave 1 (Task 9 review, Minor 5): this list carries only MUTATION
// permissions. The read routes (`GET /ops/vendors`, `/quarantine`,
// `/exceptions/*`) are guard-only at the edge (authenticated class-3, no D2
// authorize call), so a read-side permission string here would be dead; none
// is listed (a former `ops:vendor-list` entry was removed for exactly this
// reason).
// The full ops write-permission bundle (Task 2, D-B). One shared source so
// every ops-capable role grants the identical set, no per-role duplication.
//
// Phase 3 Task 1 (BRD FR-08, FR-11) adds the three damage_reason master
// MUTATION permissions (create/activate/deactivate), mirroring the
// vendor-create/vendor-suspend pair exactly. No `ops:damage-reason-list`
// entry, for the SAME reason a former `ops:vendor-list` entry was removed
// (comment above): the list route (`GET /ops/damage-reasons`) is guard-only
// at the edge (authenticated class-3, no D2 authorize call), so a read-side
// permission string here would be dead.
const OPS_PERMISSIONS = [
  'ops:upload-bank-file',
  'ops:upload-damage-file',
  'ops:status-correction',
  'ops:terminal-override',
  'ops:recompose-artifact',
  'ops:record-hold',
  'ops:record-release',
  'ops:manual-batch-trigger',
  'ops:vendor-create',
  'ops:vendor-suspend',
  'ops:vendor-edit',
  'ops:resolve-quarantine',
  'ops:resolve-intake-exception',
  'ops:resolve-status-exception',
  'ops:damage-reason-create',
  'ops:damage-reason-activate',
  'ops:damage-reason-deactivate',
  // Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
  // admin write pair (branding/template upsert, logo upload). No
  // `ops:bank-config-list` entry, same reasoning as the absent
  // `ops:vendor-list`/`ops:damage-reason-list` above: the list route
  // (`GET /ops/bank-config`) is guard-only at the edge (no D2 authorize, no
  // 6e), so a read-side permission string here would be dead.
  'ops:template-config-set',
  'ops:bank-logo-set',
  // Phase 3 Task 7 (BRD Annexure D): the Bank Master (identity.tenant)
  // admin create/edit pair, mirroring the vendor-create/vendor-edit and
  // damage-reason master CRUD exactly (shared bundle, NOT admin-tier: batching
  // was the deliberate admin-only exception). No `ops:bank-master-list` entry,
  // same reasoning as the absent `ops:vendor-list`/`ops:bank-config-list`
  // above: the list route (`GET /ops/bank-masters`) is guard-only at the edge
  // (no D2 authorize, no 6e), so a read-side permission string here would be
  // dead. No step-up (master-data maintenance, not a destructive action).
  'ops:bank-master-create',
  'ops:bank-master-edit',
]

// Phase 3 Task 6 (BRD 5.3.2): the FIRST per-role permission differentiation.
// The batching-parameter admin write (Minimum Lot Size / Maximum Wait Time) is
// an admin-tier operation: Bhupender ratified it goes to the `admin` and
// `super_admin` roles ONLY, NOT into the shared OPS_PERMISSIONS bundle (so the
// baseline `ops` / `ops_portal` operator does NOT get it). No read permission
// is listed: the list route (`GET /ops/batching-config`) is guard-only at the
// edge (no D2 authorize, no 6e), so a read-side string here would be dead, the
// same reasoning as the absent `ops:vendor-list` / `ops:bank-config-list`. No
// step-up is added (step-up for batching config is TBD per the ratification;
// this deliberately introduces no OPS_STEP_UP_CATALOG / S15 entry).
const ADMIN_TIER_PERMISSIONS = ['ops:batching-config-set']

export const OPS_ROLES: RoleConfig['roles'] = {
  // Retained legacy alias (Task 2, D-B): no real login mints role:ops_portal
  // (only tests do); kept unchanged so those tests keep passing.
  ops_portal: humanRole({
    permissions: OPS_PERMISSIONS,
    ceiling: 'all-programs',
    requiredAcr: 'AAL2',
  }),
  // The real AndPayments human operator roles (Task 2, D-B). `ops` gets the
  // shared ops bundle exactly like ops_portal; `admin` / `super_admin` get the
  // shared bundle PLUS the admin-tier permissions (T6). support_readonly is
  // deliberately absent (read-only, no OPS_ROLES entry needed).
  ops: humanRole({
    permissions: OPS_PERMISSIONS,
    ceiling: 'all-programs',
    requiredAcr: 'AAL2',
  }),
  // admin / super_admin additionally carry the admin-tier permissions (the
  // batching-config write), the first per-role differentiation (T6). ops /
  // ops_portal above stay on the shared bundle only.
  admin: humanRole({
    permissions: [...OPS_PERMISSIONS, ...ADMIN_TIER_PERMISSIONS],
    ceiling: 'all-programs',
    requiredAcr: 'AAL2',
  }),
  super_admin: humanRole({
    permissions: [...OPS_PERMISSIONS, ...ADMIN_TIER_PERMISSIONS],
    ceiling: 'all-programs',
    requiredAcr: 'AAL2',
  }),
}

export function loadOpsConfig(): RoleConfig {
  return { roles: OPS_ROLES, vendorSets: {} }
}
