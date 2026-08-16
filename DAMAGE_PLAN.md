# DAMAGE_PLAN.md. Damage and Replacement Workflow (feature/damage-workflow)

Authority: the 13 Aug 26 BRD update "Revised Damaged and Replacement Workflow",
decisions D-24 to D-31, delivered as a handoff prompt on 16 Aug 26. Those
decisions SUPERSEDE the damage-file-upload design (old D-20 and D-21 are void),
including this repo's PLAN.md sections that describe file-driven damage ingest
and the UAT ruling R-6 (docs/plan/UAT_DECISIONS_2026-08-16.md), which deferred
exactly this workflow. There is NO damage file ingestion anymore.

Branch: feature/damage-workflow, cut from local main at 117c75b. Recorded
decision: origin/main (0baf919) predates the UAT P0 work (per-bank batching,
activation card, walkthrough fixes) which lives on uat/p0-2026-08-16; the
damage workflow builds on that state, so "latest main" means local main here.

Stack note: the prompt's context line says MySQL and Redis. This repo is
Postgres per context via Prisma, Kafka via Redpanda, and the prompt also says
to follow existing repo conventions, so conventions win. Nothing in D-24 to
D-31 depends on the engine.

## 1. Audit: what exists (three subagent sweeps, 16 Aug 26)

The repo already implements most of D-24 and D-28, fed by the file today:

- A damage case IS the replacement assignment (services/tms/SPEC.md:110).
  tms.assignment carries billable, replacement_of (the parent link),
  damage_reason, bank_remarks, ops_remarks, case_status (Open, In-Progress,
  Closed, forward-only), demand_state incl. replacement-raised.
- Child mint exists: services/tms/src/damage.ts ingestDamageRowWithinTx
  matches on (bank_reference_code, vpa_value), resolves groups via the O-1
  seam (damage-resolution.ts), inserts the child (billable=false,
  replacement_of, case_status='Open'), emits
  fct.tms.assignment.replacement_raised.v1, then emitDemandFact, so the child
  enters the normal pool with zero special-casing downstream.
- Case lifecycle exists: damage-case.ts advanceCaseStatusWithinTx
  (forward-only, replacements only); projectDispatchToCases moves Open to
  In-Progress on fct.fulfillment.dispatch.v1 (SENT_TO_VENDOR or later);
  activateAssignmentWithinTx closes the case on activation (soundbox
  terminal). The collateral terminal (Delivered) is NOT automated (PLAN.md
  Q26 left it manual).
- damage_reason master exists in tms with the 'others' row (13 Aug
  migration), full ops CRUD, read-only portal tab, preserved by the test
  teardown as master data.
- Reads and UI exist: readDamageCases + GET /ops/damage-cases +
  DamageCasesPage; manual case-status override
  POST /ops/records/:asgnId/damage-case-status (ops:update-damage-case).
- Analytics: dispatch_row carries is_replacement, original_dispatch_id,
  damage_reason, replacement_dispatch_id, replacement_status, billable_flag;
  the damaged-replacement report and the damagedReplacementOpen tile exist
  but are frozen at RAISED because case_status is deliberately never
  projected into analytics.
- Auth: internal_principal.role is an unconstrained string riding the token
  as psr 'role:<name>'. A role must exist in BOTH
  services/auth/src/config/roles.ts (else login 401 unknown-role) AND
  services/fulfillment/src/ops-config.ts OPS_ROLES (else every ops mutation
  403s). Mutations are permission-gated per route (ops:* strings). Reads,
  downloads, and CSV exports are guard-only with NO permission concept, and
  three upload previews (device-inventory, unit-status, return) run no
  authorize at all.
- No VPA search read exists anywhere. vpa_value lives on tms.assignment (and
  the pool projection); functional index lower(vpa_value) already exists.
- No operator-creation HTTP endpoint exists. Provisioning is the gitignored
  harness (direct insert). That stays true for the new role.

## 2. Delete, keep, build

DELETE (D-25, file ingestion is gone):
- services/tms/src/damage.ts (ingest, match, quarantine emit). The
  CASE_STATUS_VALUES / normalizeCaseStatus block moves to damage-case.ts.
- services/tms/src/damage-resolution.ts (the O-1 seam). D-26 makes the
  operator the resolver, so the strategy has no caller left.
- The damage half of services/tms/src/bank-file-adapter.ts (mapping,
  normalizeDamageRow, parseBankDamageFile). parseBankFile itself stays, the
  bank-request parser uses it.
- services/tms/src/ops.ts previewDamageFile + commitDamageFile.
- apps/ops-edge/src/ops.controller.ts POST /ops/uploads/damage/preview and
  /ops/uploads/damage/commit.
- apps/ops-portal: DamageUploadPage.tsx, the uploadKinds 'damage' entry, the
  UploadsPage index card and route, the endpoints.ts damage-upload API
  surface, the BankIngestPage cross-reference copy.
- The permission string ops:upload-damage-file.
- Tests of the deleted surfaces (tms damage ingest and adapter damage cases,
  edge upload routes, portal upload page).
- NOT deleted: no damage staging table exists to drop. ingest_file rows with
  source='bank_damage' are history and stay; nothing writes that source
  anymore. Historical quarantine rows with damage reason codes stay readable;
  no new ones can be born.

KEEP (already correct under the new decisions):
- assignment.{billable, replacement_of, damage_reason, ops_remarks,
  case_status}, the (source_event_id, dispatch_group) unique, emitDemandFact.
- damage-case.ts lifecycle incl. projectDispatchToCases; activation close.
- damage_reason master, its CRUD, its portal tab, the 'others' row.
- fct.tms.assignment.replacement_raised.v1 and all three consumers
  (fulfillment unit DAMAGED projection, analytics REPLACEMENT fold).
- readDamageCases, DamageCasesPage, updateDamageCaseStatusOps (manual
  override remains the escape hatch).
- The analytics damaged-replacement report.

BUILD:
- B1. Flag Damage write in tms (D-26, D-27, D-28): flagDamageOps.
- B2. VPA search read in tms (D-26): searchDispatchesByVpa.
- B3. Case summary read in tms (D-31): countDamageCasesByStatus.
- B4. Collateral terminal close (D-24): tms subscribes to
  fct.fulfillment.shipment.v1, DELIVERED with asgnIds closes COLLATERAL
  replacement cases. Soundbox close on activation already exists.
- B5. Edge routes: POST /ops/records/:asgnId/flag-damage (ops:flag-damage),
  GET /ops/dispatches/by-vpa, GET /ops/damage-cases/summary. Delete the two
  damage upload routes. Gate the three ungated previews on their own upload
  permissions.
- B6. customer_support role (D-29) in both role configs, plus the first
  read-side restriction machinery in ops-edge (downloads, CSV export, config
  views) since guard-only reads cannot express "no download" today.
- B7. Portal (D-26, D-27, D-31): Flag damage dialog on DispatchDetailPage,
  VPA search + status filter + summary chips on DamageCasesPage, dashboard
  tile with drill-down, CS-aware nav (display convenience only, never
  authorization), remove the upload UI.
- B8. Non-Billable respected in report and export queries (billable column
  surfaced on report rows and CSV, D-28 tail).
- B9. Migration: assignment.flagged_by (nullable text, the D-27 created_by).
  Everything else needed already exists.

## 3. Recorded decisions and adaptations (DP series)

- DP-1. No new damage_cases table. The prompt sketches one, and also says
  "adapt to what the repo actually has" and (D-24) "do not fork the dispatch
  state machine". The case overlay already lives on the replacement
  assignment with a forward-only status and event-driven transitions.
  A parallel table would duplicate that state. We extend the overlay with
  flagged_by and keep everything else.
- DP-2. The child inherits the flagged leg's dispatch_group. The operator
  flags a specific Dispatch ID, which is already one W-5 leg (SOUNDBOX or
  COLLATERAL), so soundbox-vs-standee ambiguity no longer exists by
  construction. Flagging a SOUNDBOX leg mints a SOUNDBOX child (quantity
  fixed at 1, D-27 and D-6, no count input). Flagging a COLLATERAL leg mints
  a COLLATERAL child with the operator's standee and sticker counts, total
  at least 1. This retires the O-1 resolution seam.
- DP-3. Duplicate rule (asked to decide and document): one live case per
  dispatch. Flagging is rejected with 409 conflict while the dispatch has a
  child whose case_status is not 'Closed'. After the case closes a new flag
  is allowed (repeat damage is real). Flagging a replacement itself is
  allowed under the same rule (a replacement can arrive damaged); D-26 lists
  "any replacements" among the flaggable dispatches.
- DP-4. source_event_id for a flagged child is 'ops-flag|<Idempotency-Key>'.
  The column is a correlation id, not a UUID (file rows use fileId|rowNo).
  The client key makes retries idempotent under the existing
  (source_event_id, dispatch_group) unique, and onceWithin dedups the
  mutation itself.
- DP-5. damage_reason on a flagged child stores the master CODE (validated
  active), not free text. File rows stored bank-sent text matched by label;
  the operator picks from the master, so the code is the honest value. The
  free-text why goes to ops_remarks (required, non-empty). 'others' is a
  normal active row, no special casing.
- DP-6. By-VPA search returns the tms side (identity, groups, counts,
  billable, parent link, case_status, demand_state, activation status). The
  courier branch status is analytics-held; the portal enriches rows via the
  existing per-dispatch detail read instead of a new cross-context merge at
  the edge. At 10 to 15 cases a day the extra reads are nothing, and no
  context boundary moves.
- DP-7. The D-31 aggregate reads tms, not analytics. case_status is
  deliberately never projected into analytics (recorded in ops.ts), so the
  tile's endpoint is a tms ops-read returning counts by status. The frozen
  analytics tile (damagedReplacementOpen) is untouched.
- DP-8. Read restriction is an ops-edge concern, not new permission strings.
  The repo has a standing convention that read-side permission strings are
  not minted. D-29 still requires "no download, no config access", so
  ops-edge gains a small helper, requireUnrestrictedRead(claim), driven by a
  READ_RESTRICTED_ROLES set containing 'customer_support', applied to: the
  two batch binary downloads, report CSV export (format=csv), GET
  /ops/bank-config, GET /ops/batching-config. Everything else CS needs
  (dispatches, by-vpa, dispatch detail, merchants, damage-cases, summary,
  damage-reasons, bank-masters, JSON report views) stays guard-only.
- DP-9. The three ungated upload previews get the same authorizePreview gate
  the bank preview already has, on their own upload permission. Existing
  roles all hold those permissions, so nothing changes for them; CS is
  denied. This closes an audit gap D-29 would otherwise leak through.
- DP-10. In-Progress stays where it is: dispatch.v1 SENT_TO_VENDOR or later.
  D-24 says "child dispatch in pipeline"; the built transition is the
  narrowest existing reading and is forward-only. Widening to
  batched-means-in-progress is a one-line change if ruled.
- DP-11. Case closure for COLLATERAL children automates via the shipment
  fact (B4). The fact carries asgnIds only for collateral consignments,
  which is exactly the population that needs it. This supersedes PLAN.md
  Q26's manual-close posture for replacement cases.
- DP-12. CS provisioning is the harness (direct insert with
  role='customer_support'), because no operator-creation endpoint exists and
  building one is not granted here. Tests insert principals directly, the
  established pattern.

## 4. Pinned contracts (lanes build against these verbatim)

### tms service (services/tms/src/flag-damage.ts, new)

    export interface FlagDamageArgs {
      asgnId: string          // wire asgn_ id of the flagged dispatch leg
      reasonCode: string      // damage_reason.code, must be active
      remarks: string         // required, trimmed non-empty, max 500
      standeeCount?: number   // COLLATERAL only, int 0..99
      stickerCount?: number   // COLLATERAL only, int 0..99
      clientKey: string       // Idempotency-Key
      actorId: string         // claim.sub, never a body field
      traceId: string
    }
    export interface FlagDamageResult {
      childAsgnId: string
      caseStatus: 'Open'
    }
    export async function flagDamageOps(db: TmsDb, args: FlagDamageArgs): Promise<FlagDamageResult>

Rules: parent must exist (not-found otherwise). SOUNDBOX leg rejects any
count. COLLATERAL leg requires standeeCount + stickerCount >= 1. Reason must
be an active master code. Reject 'conflict' while a non-Closed child exists
(DP-3). Child insert mirrors the old mint: snapshot fields cloned from the
parent row, counts per DP-2, billable=false, replacement_of=parent uuid,
damage_reason=reasonCode, ops_remarks=remarks, flagged_by=actorId,
case_status='Open', origin='ADDITIONAL', source_event_id per DP-4,
dispatch_group=parent's. Same transaction: replacement_raised fact,
emitDemandFact, parent demand_state='replacement-raised', opsAllow 6e audit
(IDs and enum tokens only, free text stays on the row).

### tms reads (services/tms/src/ops-read.ts)

    export interface VpaDispatchRow {
      asgnId: string
      dispatchGroup: 'SOUNDBOX' | 'COLLATERAL'
      bankReferenceCode: string
      bankDisplayName: string
      merchantDisplayName: string
      soundbox: boolean
      standeeCount: number
      stickerCount: number
      billable: boolean
      replacementOfAsgnId: string | null
      caseStatus: string | null
      demandState: string
      activationStatus: string | null
      activatedAt: string | null
      createdAt: string
    }
    export async function searchDispatchesByVpa(db: TmsDb, vpa: string): Promise<VpaDispatchRow[]>
    // match: LOWER(TRIM(vpa_value)) = LOWER(TRIM($1)), ordered created_at desc

    export interface DamageCaseSummary { open: number; inProgress: number; closed: number }
    export async function countDamageCasesByStatus(db: TmsDb): Promise<DamageCaseSummary>
    // WHERE replacement_of IS NOT NULL, grouped on case_status

### edge routes (apps/ops-edge)

    POST /ops/records/:asgnId/flag-damage      op ops:flag-damage, Idempotency-Key required
      body { reasonCode: string, remarks: string, standeeCount?: number, stickerCount?: number }
      201 { childAsgnId, caseStatus: 'Open' }
      400 validation, 404 unknown asgn, 409 live case exists
    GET /ops/dispatches/by-vpa?vpa=...         guard-only read
      200 { rows: VpaDispatchRow[] }           400 when vpa is blank
    GET /ops/damage-cases/summary              guard-only read
      200 { open, inProgress, closed }

### role entries

    services/auth/src/config/roles.ts: customer_support, shaped like
      support_readonly (permissions ['principal:read'], AAL2).
    services/fulfillment/src/ops-config.ts OPS_ROLES: customer_support
      { permissions: ['ops:flag-damage'], ceiling 'all-programs', AAL2 }.
    ops:flag-damage added to OPS_PERMISSIONS and granted to ops, admin,
      super_admin, customer_support. ops:upload-damage-file removed.
    apps/ops-edge read restriction per DP-8.

### portal API additions (apps/ops-portal/src/api/endpoints.ts)

    flagDamage(client, asgnId, body) -> { childAsgnId, caseStatus }
    searchDispatchesByVpa(client, vpa) -> VpaDispatchRow[]
    getDamageCaseSummary(client) -> { open, inProgress, closed }

## 5. Build lanes (parallel subagents, disjoint files)

- Lane T (tms core): B1 to B4, B9, deletions in services/tms, consumer
  route subscription, tms + consumer tests. Owns services/tms/**,
  apps/consumer/src/routes.ts.
- Lane E (edge): B5, B6, deletions in ops.controller.ts, edge tests (flag
  route, RBAC boundary: CS flags yes, uploads no, downloads no). Owns
  apps/ops-edge/**, services/fulfillment/src/ops-config.ts,
  services/auth/src/config/roles.ts.
- Lane P (portal): B7, portal deletions, portal tests. Owns
  apps/ops-portal/**.
- Lane A (analytics): B8, report tests. Owns services/analytics/**.

Lanes write code and tests but run NO database-backed suites (shared dev
Postgres, serial-only by design). Integration, bash ./infra/db.sh, pnpm -r
build, lint, typecheck, and the full gate run once, serially, after the
lanes land. The demo harness must be DOWN before the gate (a test run
truncates the shared database) and demo state reseeded after.

## 6. Open questions (parked, none blocking)

- OQ-1. Flag-of-a-replacement is allowed (DP-3). Confirm.
- OQ-2. CS keeps JSON report views and device detail (full ICCID visible);
  only downloads, CSV, and config views are denied (DP-8). Confirm the line.
- OQ-3. In-Progress at SENT_TO_VENDOR, not at batching (DP-10). Confirm.
- OQ-4. "Non-Billable respected in exports" is read as: the flag rides the
  report rows and CSV so billing can exclude it. No report row is hidden.
  Confirm.
- OQ-5. Historical file-born damage rows (source_event_id 'fileId|rowNo',
  damage_reason as free text) stay as-is; the case list renders both old
  text and new codes. Confirm no backfill wanted.

## 7. Lane deviations, recorded at landing (16 Aug 26)

All four lanes landed on contract. The deliberate deviations, kept:

- DP-13 (Lane T). countDamageCasesByStatus tallies case_status rows in
  TypeScript instead of a SQL aggregate: test/architecture.test.ts statically
  bans aggregate calls in tms ops-read source. Signature and result verbatim.
- DP-14 (Lane T). replacement_raised.bankRemarks is '' on a flagged child.
  No bank wrote anything and operator free text never rides a fact (S7); the
  wire schema requires only asgnId and replacedAsgnId.
- DP-15 (Lane T and E, converged). DP-3's duplicate rule is expressed as
  OpsClientError kind 'conflict' in the domain, mapped to 409 by the ops-edge
  error filter, which gained that mapping. A same-key replay returns the
  pinned literal caseStatus 'Open' even if the case has since advanced.
- DP-16 (Lane T). COLLATERAL counts: an omitted count defaults to 0, each
  supplied value must be an integer 0 to 99, total at least 1.
- DP-17 (Lane P). The D-31 card lives on TilesPage (the Command Center owns
  the tiles; ReportPage was a wrong pointer in the brief). Legacy pre-split
  dispatches with a null dispatch_group get no flag control, DP-2's count
  rules key on the leg's group. Client-composed print-run PDFs are not
  restricted for customer_support, DP-8 names only server binary downloads.
- Lane A note. Report rows expose the column as 'billable'; the tile
  drilldown has long exposed 'billableFlag'. Both correct per surface, named
  here so the difference is never read as drift.

## 8. Progress

- [x] Audit (three subagent sweeps recorded above)
- [x] Plan (this file)
- [x] Lane T: tms core (migration applied, flagDamageOps, reads, shipment
      close listener, ingest deletion, tests written)
- [x] Lane E: edge + role (routes, preview gates, read restriction,
      customer_support in both configs, tests written)
- [x] Lane P: portal (flag dialog, VPA search, chips and deep link, D-31
      card, CS nav gating, upload UI deleted; ops-portal suite green,
      53 files, 376 tests)
- [x] Lane A: analytics billable (column on both reports, CSV rides free,
      tests written)
- [x] Integration: db.sh applied (flagged_by verified in tms.assignment),
      pnpm -r build green, lint green, typecheck green
- [x] Full gate green: 286 files, 2302 tests, exit 0 (two cross-lane test
      fixes first: the C4 scrub banned a literal path in the auth role
      comment, and the ops-config suite still pinned the retired
      ops:upload-damage-file)
- [x] Live verification through the portal, 16 Aug 26: upload page shows no
      damage card; VPA search returns both legs; COLLATERAL flag (reason
      physical_damage, counts 1 and 2) minted a non-billable child with
      flagged_by, source_event_id 'ops-flag|<key>', parent flipped to
      replacement-raised, pool entry POOLED non-billable; SOUNDBOX flag shows
      the fixed-one line and no count inputs; the flag control disappears
      while a case is live (409 additionally pinned by the edge suite);
      chips and the D-31 Command Center tile count live and deep-link
      through ?status=; uat.cs1 (customer_support) logged in, nav gated,
      searched by VPA and flagged a dispatch (audit row carries the CS
      principal); all three cases advanced Open to In-Progress off the real
      LOT_SIZE batch fact; analytics folded the three replacement rows
      billable_flag false. Collateral DELIVERED to Closed is test-verified
      (eight-case listener suite), not live-driven.
- [x] DAMAGE_SUMMARY.md
- [ ] Commits on feature/damage-workflow (no merge, no push without the
      exact phrase)
