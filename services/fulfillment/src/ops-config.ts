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
  // D-8 (12 Aug 2026): the OTHER of the review queue's two actions. Its own
  // operation string, not a flag on resolve, because the co-committed 6e
  // carries the operation and "I archived a real order unfilled" is a
  // different claim from "I corrected and reprocessed it".
  'ops:close-quarantine',
  'ops:resolve-intake-exception',
  'ops:resolve-status-exception',
  'ops:damage-reason-create',
  'ops:damage-reason-activate',
  'ops:damage-reason-deactivate',
  // FR08-2 (BRD 5.8): transition a replacement's damage case_status
  // (Open/In-Progress/Closed). Shared ops bundle, not admin-tier. No
  // `ops:damage-case-list` entry, same reasoning as the other absent -list
  // permissions above (the list route authorizes without its own permission).
  'ops:update-damage-case',
  // Phase 3 Task 5b (BRD Annexure D.4): the bank/branch composition-config
  // admin write pair (branding/template upsert, logo upload). No
  // `ops:bank-config-list` entry, same reasoning as the absent
  // `ops:vendor-list`/`ops:damage-reason-list` above: the list route
  // (`GET /ops/bank-config`) is guard-only at the edge (no D2 authorize, no
  // 6e), so a read-side permission string here would be dead.
  'ops:template-config-set',
  'ops:bank-logo-set',
  // Task 6 (M2 dispatch trim ruling): the audited dispatch-artwork master
  // upload (soundbox_template_ref / collateral_template_ref). Distinct from
  // 'ops:template-config-set' above, which upserts the JSONB branding/
  // image-template columns, not an asset.
  'ops:bank-template-master-set',
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
  // Phase 5 Task 1 (D-G, FR-01a): the ops device-inventory upload, the ops
  // analog of the vendor-channel manufacturer intake. Same tier as every
  // other upload (ops:upload-bank-file, ops:upload-damage-file), not
  // admin-tier. No list permission is needed (no new list route is added by
  // this task).
  'ops:upload-device-inventory',
  // Phase 5 Task 2 (D-H.1, BRD Phase-1 MANUAL activation flow): ops marks a
  // DELIVERED assignment activated (CWD already activated the device+SIM out
  // of band). Shared ops bundle, same tier as every other ops action here;
  // not admin-tier (batching-config-set is the deliberate admin-only
  // exception, T6). No list permission is needed (no new list route is added
  // by this task).
  'ops:mark-activated',
  // D-16 (T4.1b, 13 Aug 2026): the OTHER half of the activation branch. This
  // records that the activation request has LEFT US for the CWD, which is the
  // window an operator chases and which nothing could express before. Its own
  // operation string rather than a flag on mark-activated, for the same reason
  // close-quarantine has one: "I sent this to the CWD" and "the CWD confirmed
  // it" are different claims, and the co-committed 6e carries the operation.
  'ops:request-activation',
  // D-17 (T5.1, 13 Aug 2026): the courier emails its morning status file and an
  // operator uploads it. Its own permission rather than reuse of
  // ops:upload-device-inventory, because the two uploads move different things
  // and an operator entitled to load stock is not thereby entitled to move
  // parcels through the delivery ladder.
  'ops:upload-courier-status',
  // Merged from the inventory-ownership branch, 13 Aug 2026. A union, not a
  // choice: these four name four different operator actions and none subsumes
  // another.
  //
  // 2026-08-13 ruling: a manual unit-status correction, one device at a time
  // from the device page. Same tier as every other ops mutation here; the
  // forward-only guard (unit-lifecycle.ts) is what limits this, not the role.
  'ops:unit-status-correction',
  // The bulk sheet-upload sibling of the above: many devices, one file. Same
  // tier, same guard, per-row tolerant like every other upload in this bundle.
  'ops:upload-unit-status',
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
// Task 12 (W-6): the PRINT vendor print_layout admin write joins the SAME
// admin-tier bundle as batching-config-set (not the shared OPS_PERMISSIONS
// bundle), per the ratification: a baseline `ops` / `ops_portal` operator
// does not get it either. No `ops:vendor-print-layout-list` entry, same
// reasoning as every other absent -list permission above (there is no new
// list route here; a vendor's print_layout rides the existing vendor read).
// Not step-up-gated (not in OPS_STEP_UP_CATALOG), matching batching-config's
// own no-step-up posture.
const ADMIN_TIER_PERMISSIONS = ['ops:batching-config-set', 'ops:vendor-print-layout-set']

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
