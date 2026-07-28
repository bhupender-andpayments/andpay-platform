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
export const OPS_ROLES: RoleConfig['roles'] = {
  ops_portal: humanRole({
    permissions: [
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
      'ops:resolve-quarantine',
      'ops:resolve-intake-exception',
      'ops:resolve-status-exception',
    ],
    ceiling: 'all-programs',
    requiredAcr: 'AAL2',
  }),
}

export function loadOpsConfig(): RoleConfig {
  return { roles: OPS_ROLES, vendorSets: {} }
}
