# REVIEW_REPORT.md. Damage workflow branch and whole-system review, 16 Aug 26

Scope: `feature/damage-workflow` at `9ca54b2`, reviewed against decisions
D-24 to D-31 and the system as a whole with the branch applied. Method:
adversarial code verification with file citations (the summary docs were used
only as a list of claims), one full gate run at the review tip (286 files,
2302 tests, exit 0), and no code changes. Two consumer-contract findings were
proven by tracing emitter payloads against consumer expectations; no probe
tests needed writing because the drift is visible in the payload builders.

A note on method: five review subagents were launched and died on an org
spend limit; the review completed in the main session. Coverage below states
what was verified directly versus reasoned; nothing is reported as checked
that was not.

---

## Findings, by severity

### F1. BLOCKER. The collateral case-close listener is unreachable from real events (D-24 half-broken)

The D-24 close for standee lines subscribes tms to
`fct.fulfillment.shipment.v1` and requires `status === 'DELIVERED'` AND a
non-empty `asgnIds` (`services/tms/src/damage-case.ts`,
`projectShipmentToCases`). But NO status-transition emitter ever populates
`asgnIds`:

- `services/fulfillment/src/courier-status.ts:153-170` (webhook, file, and
  ops-correction paths all funnel here) builds the payload with
  `shptId, awb, courierPartner, status, courierTimestamp, statusSource` only.
- `services/fulfillment/src/ops.ts:271-285` (terminal override) builds the
  same shape.
- `collateral` and `asgnIds` (`services/fulfillment/src/events.ts:71-77`,
  "Present ONLY on a collateral fact") ride only the spec-08 birth fact,
  which is never DELIVERED.

So a collateral replacement case never closes from a real courier event; only
the manual `ops:update-damage-case` path closes it. The listener suite passed
because `services/tms/test/damage-case.test.ts:64-65` hand-builds envelopes
WITH `asgnIds`, testing the handler against a payload the emitter never
produces.

Fix: at both transition-emit sites, when the shpt is a collateral consignment
(lookup `pending_pool_entry WHERE collateral_shipment = <shpt uuid>`,
`services/fulfillment/prisma/schema.prisma:229`), enrich the payload with
`collateral: true` and the covered `asgnIds`. This is inside the documented
fact shape (additive, wire-compatible). Add an emitter-contract test that
drives `advanceShipmentStatus` to DELIVERED on a collateral shipment and
asserts the OUTBOX payload carries `asgnIds`, then an end-to-end test from
that fact to `case_status = 'Closed'`.

### F2. SHOULD-FIX. The one-live-case rule is read-then-insert with no lock and no constraint

`services/tms/src/flag-damage.ts:155-163` checks for a non-Closed child, then
inserts. No `FOR UPDATE` on the parent, no unique constraint backs the rule.
Two concurrent flags with DIFFERENT Idempotency-Keys both pass the check and
mint two children and two cases for one complaint (`source_event_id` differs,
so the existing unique does not collide). At 10 to 15 cases a day the window
is small; the guard is still missing, and it is also untested.

Fix: a partial unique index,
`CREATE UNIQUE INDEX ... ON assignment (replacement_of) WHERE replacement_of IS NOT NULL AND case_status IS DISTINCT FROM 'Closed'`,
which is exactly "one live child per parent" (closed children stay
unbounded), and map the unique violation to the same `conflict` 409. One
migration, two lines in the catch, one race test.

### F3. SHOULD-FIX. Customer Support can reach admin MFA enrollment (pre-existing, newly material)

`apps/auth-edge/src/admin.guard.ts` admits ANY class-3 principal with no
permission check, and `apps/auth-edge/src/enroll.controller.ts:89-98` gates
the enroll-someone-else branch on step-up only. The `mfa:enroll` permission
strings in `services/auth/src/config/roles.ts` are not evaluated anywhere. A
customer_support principal can therefore step up (their own TOTP) and enroll
an MFA factor for another handle. This predates the branch (every class-3
role had it), but D-29 is the first deliberately restricted role, so the gap
is now a real boundary violation rather than a theoretical one.

Fix: evaluate the auth-plane role's permissions in the admin-enrollment
branch (the config vocabulary already exists; the check is one `authorize`
call), and extend `rbac-customer-support` style coverage to auth-edge.

### F4. SHOULD-FIX. The damaged device is never written off: the unit projector targets the wrong assignment (pre-existing on main)

`services/fulfillment/src/unit-lifecycle.ts:218-241`
(`projectReplacementToUnits`) writes units DAMAGED for
`env.payload.asgnId`. In the emitter
(`services/tms/src/events.ts:62-67`), `asgnId` is the CHILD and
`replacedAsgnId` is the damaged parent. The child has no units at flag time,
so the write-off is a permanent no-op, and the damaged device stays
DELIVERED or ACTIVATED in inventory forever. The suite did not catch it for
the same reason as F1: `services/fulfillment/test/unit-lifecycle.test.ts:234`
seeds the unit ON the fact's `asgnId`, a payload semantics the producer never
has. Pre-existing (the deleted file-ingest minted the same fact shape), and
material now that flags mint these facts routinely.

Fix: the projector reads `replacedAsgnId` (add it to the view type; the field
has always been on the wire), and the test seeds units on the parent while
passing the child in `asgnId`, pinning the production field semantics.

### F5. SHOULD-FIX. The three newly gated previews have a 403 test but no surviving 200 test

`apps/ops-edge/test/rbac-customer-support.test.ts:201-207` pins that CS gets
403 on all four previews. No test pins that a FULL role still gets 200 from
the three previews that gained `authorizePreview` on this branch
(device-inventory, unit-status, return); their happy paths are exercised only
indirectly through upload-flow tests that go straight to commit. If a future
permission edit broke the preview gate for full roles, nothing red would say
so at the preview itself.

Fix: one it-block asserting an ops-role principal gets 200 from each of the
three previews.

### F6. SHOULD-FIX. Two damage tiles on the dashboard now disagree by design

`damagedReplacementOpen` (analytics) counts `replacement_status === 'RAISED'`
and NEVER decrements, because case_status is deliberately not projected
(recorded posture). The new D-31 card partitions the SAME population into
Open, In progress, Closed. On one Command Center the frozen tile reads "N
open" while the card reads X + Y + Z = N with X < N. Before the branch the
frozen tile was merely coarse; beside the live card it is actively
misleading.

Fix: retire the frozen tile or relabel it "replacements raised (all time)".
Which one is a product call (listed in the questions section).

### Nits

- N1. `services/tms/src/ops.ts:702` comment cites `damage.ts`, which is
  deleted. Retarget the pointer.
- N2. A replacement with NULL `case_status` would be shown by the case list
  (`IS DISTINCT FROM 'Closed'`) but counted in NO bucket by
  `countDamageCasesByStatus` (`services/tms/src/ops-read.ts`). No live code
  path can mint one (both mints write 'Open'); the F2 partial index migration
  is a natural place to also add a CHECK or backfill if wanted.
- N3. A customer_support login lands on whatever route the session last held
  (for example the uploads index); nav hides it, routes are not client-gated,
  enforcement is at the edge (the recorded S24/T14 posture). A CS-specific
  landing default is polish.
- N4. The D-31 brief said "tenant-scoped" counts; both new reads run
  platform-wide as `tms_ops_read`, consistent with EVERY ops read in the
  repo. Documented deviation, not a defect; belongs with the corpus wording.
- N5. The teardown's Kafka pass emits one cosmetic kafkajs
  TimeoutNegativeWarning line per gate (documented in the commit).
- N6. Historical file-born damage quarantine rows keep main's resolve dead
  end (resolving one mints a bank-request child). No new rows of that kind
  can be born; close remains the sane exit for the historical ones.

---

## Part 1 verdicts, D-24 to D-31

| Decision | Verdict | Evidence |
| -------- | ------- | -------- |
| D-24 case overlay | VERIFIED WITH FINDINGS (F1) | Open at flag (`flag-damage.ts`), In-Progress via `projectDispatchToCases` on SENT_TO_VENDOR or later, Closed on activation (`assignment.ts:408-419`). The collateral close is wired (`damage-case.ts`, `apps/consumer/src/routes.ts` tmsRoutes) but unreachable until F1. Dispatch statuses are NOT duplicated onto the case; the case row carries only case fields plus the assignment's own columns. |
| D-25 no file ingestion | VERIFIED | `damage.ts`, `damage-resolution.ts`, adapter damage half, preview/commit services and routes, portal page/kind, permission: all gone. Greps for parser and route remnants return only history-explaining comments plus N1's stale pointer. No staging table ever existed to drop. |
| D-26 human resolves | VERIFIED | `searchDispatchesByVpa` (`ops-read.ts`, LOWER/TRIM match), route `GET /ops/dispatches/by-vpa`, portal search on DamageCasesPage with per-row status; `flagDamageOps` has NO status guard on the parent (flaggable from any status; only existence and the live-case rule gate it); no soundbox-vs-standee resolution logic survives anywhere (the strategy seam is deleted). Delivery-branch status on search rows comes from the portal's per-dispatch enrichment, activation from tms directly. |
| D-27 three captures | VERIFIED | 'others' active row (migration `20260813140000`); remarks required/trimmed/max 500 at service (`flag-damage.ts`), edge body validation, and portal dialog (with remaining-count); COLLATERAL ints 0..99 total >= 1 at all three layers; SOUNDBOX rejects counts at the service and edge and the portal renders NO count inputs (verified live and pinned in `dispatch-detail.test.tsx`). |
| D-28 child, standard flow | VERIFIED WITH ADJACENT FINDING (F4) | Child: `billable=false`, `replacement_of`, counts, normal demand fact; grep of `batching.ts`, `dispatch.ts`, `package.ts`, `courier-status.ts`, activation paths finds NO replacement-specific branching (the only replacement-aware consumers are the case projectors and `projectReplacementToUnits`, which F4 shows targets the wrong assignment). Live-verified: a flagged child rode a real LOT_SIZE batch. Bidirectional link: child to parent via `replacement_of`; parent to child via the case list projection and analytics `replacement_dispatch_id`. |
| D-29 CS role | VERIFIED WITH FINDINGS (F3 boundary, N3) | Exactly `ops:flag-damage` on the ops plane plus the read deny list (downloads, CSV, config views); the negative suite (`rbac-customer-support.test.ts`) proves upload, preview, download, CSV, config, batching denials and full-role non-leakage. The auth-plane enroll gap is F3. |
| D-31 dashboard | VERIFIED WITH CAVEATS (F6, N2, N4) | Summary endpoint + Command Center card + `?status=` drill-down verified live; tile and list reconcile exactly today because both mints write 'Open' and both reads share the `replacement_of IS NOT NULL` population (NULL-status corner in N2). |
| D-30 | NOT PRESENT | Absent from the handoff numbering; nothing built against it; recorded in the corpus submission so the gap is deliberate on both sides. |

Atomicity: the claim "case + child + pool entry in one transaction" is
imprecise and the code is RIGHT rather than the claim: case + child + both
facts + parent flip + 6e audit commit in ONE tms transaction
(`flag-damage.ts`, all inside `onceWithin`); the POOL ENTRY is created by the
fulfillment consumer of the demand fact, exactly like every ordinary
dispatch. Partial failure across that boundary is the transactional outbox's
at-least-once with inbox dedup: flag committed but relay down means the case
exists and the child pools when the relay drains; a consumer crash redelivers
into `ON CONFLICT (asgn_id) DO NOTHING`. Replay with the same Idempotency-Key
returns the same child and enqueues nothing twice (pinned in
`flag-damage.test.ts`). No hole found beyond the F2 race.

---

## D-1 to D-31 coverage table (whole system, branch applied)

Verdicts for D-1 to D-24 are from PLAN.md's audited ledger (lines 120-284)
plus a branch-delta check; the damage branch touched none of the core
pipeline code paths those decisions live in (its only core touchpoints are
the consumer subscription and the two config files), and the full gate at the
review tip is green, so main behavior verdicts carry.

| Decision | One line | Verdict |
| -------- | -------- | ------- |
| D-1 no CWD-to-vendor tracking | complies by absence | implemented |
| D-2 pool entry exactly once | unique + terminal guards | implemented |
| D-3 actor is Ops | claim-derived actor everywhere (incl. new flag route) | implemented |
| D-4 QR string mandatory | canonical layer enforces | implemented |
| D-5 conditional duplicate rule | built as ruled (R-2 pinned the reading) | implemented |
| D-6 one soundbox per VPA | gate-enforced; D-27 leans on it (fixed 1) | implemented |
| D-7 two Dispatch IDs (W-5) | the split the child inherits | implemented |
| D-8 review queue close or cure | queue + partial accept + audit | implemented (historic damage rows keep the dead end, N6) |
| D-9 no expiry/TAT | complies by absence | implemented |
| D-10 tenant-scoped config | tenant tiers + R-7 bank min-lot tier | implemented |
| D-11 one image per merchant per type | ONE_PER_PAGE; GRID_3X2 carve-out awaiting corpus write-down | implemented (corpus mirror owed) |
| D-12 two Excels + images | group-keyed | implemented |
| D-13 one AWB per dispatch id | soundbox leg enforced; T1.2 legacy scope open (Q15) | partial (as recorded on main) |
| D-14 partial returns | workbook path | implemented |
| D-15 duplicate returns to review queue | DETECTION DOES NOT EXIST on main (PLAN.md:200) | missing (main gap; a child dispatch inherits it identically: the brief's "duplicate vendor-return for a child lands in the queue" cannot pass for ANY dispatch today) |
| D-16 parallel branches | delivery + activation axes | implemented |
| D-17 courier tracking phase 1 | manual + file + webhook paths | implemented |
| D-18 failed/returned dead end | RETURNED terminal | implemented |
| D-19 activation recording | single + bulk with per-row results | implemented |
| D-20 no quantity in damage file | VOID with its subject (D-25 deleted the mapping) | void-superseded |
| D-21 VPA-exists validation | VOID with its subject | void-superseded |
| D-22 Others reason | active 'others' row, preserved master | implemented |
| D-23 unconditional replacement pipeline | child batches and composes QR like any dispatch (live-verified) | implemented |
| D-24 case overlay | see Part 1 | implemented, F1 pending |
| D-25 to D-29, D-31 | see Part 1 | implemented (F-list applies) |
| D-30 | not present in any ledger | not recorded |

Silently-broken-main sweep: no main code referenced the deleted symbols (the
gate's typecheck pass proves it); `demand_state = 'replacement-raised'` and
`case_status` consumers unchanged; `ingest_file.source = 'bank_damage'` has
no reader that branches on it; the portal queues render historical damage
reason codes as plain text (no dead component). Nothing silently broken was
found beyond the pre-existing F4.

Ripple check: a flag-born child renders as an ordinary dispatch everywhere
(report row, dispatch detail, batches, devices); its pairing is visible on
the damage-cases screen and analytics carries `replacement_dispatch_id`.
Exports carry `billable` (both reports, CSV via key union). Ship-to
amendment, hold/release, terminal-override, and vendor return operate on the
child with zero special-casing (no replacement branching exists in those
paths to get wrong). Delivered-not-activated counts a child soundbox like any
soundbox (correct: a replacement device really is delivered-not-activated
until activated). The two-damage-tiles contradiction is F6. Duplicate
vendor-return: see D-15 above, a main gap the child inherits equally.

---

## RBAC matrix (ops plane roles x route classes)

Full roles: `ops_portal`, `ops` (OPS_PERMISSIONS bundle), `admin`,
`super_admin` (bundle + admin tier). CS: `customer_support`
(`ops:flag-damage` only + read deny list). Source:
`services/fulfillment/src/ops-config.ts`, `apps/ops-edge/src/read-restriction.ts`,
verified by `apps/ops-edge/test/rbac-customer-support.test.ts`.

| Route class (ops-edge) | ops_portal/ops | admin/super_admin | customer_support |
| ---------------------- | -------------- | ----------------- | ---------------- |
| POST uploads (bank, device-inventory, courier, unit-status, return, activation) + their previews | allow | allow | DENY (permission; previews via DP-9 gate) |
| POST flag-damage | allow | allow | ALLOW (the one mutation) |
| POST damage-case-status, damage-reasons CRUD, holds, releases, corrections, overrides, vendor CRUD, quarantine/exception resolves, batch trigger, ship-to amend, activate (+bulk) | allow | allow | DENY (permission) |
| POST batching-config, bank-config writes, bank-masters writes | DENY (admin tier) | allow | DENY |
| GET dispatches, by-vpa, merchants, devices (incl. :unitId full ICCID), pool, batches/:id, quarantine, exceptions, damage-cases (+summary), damage-reasons, bank-masters | allow | allow | ALLOW (view class; the ICCID and quarantine reads are flagged as a product line question, not a code defect) |
| GET batch excel / collateral downloads | allow | allow | DENY (read restriction) |
| GET reports JSON (all), dispatch detail | allow | allow | ALLOW |
| GET reports format=csv | allow | allow | DENY (before the read audit) |
| GET bank-config, batching-config (views) | allow | allow | DENY (config class) |

Other edges: auth-edge session routes are public-or-cookie by design; the
enroll admin branch is F3. vendor-edge and vendor-auth-edge admit class 6/7
only, vendor resolved server-side from the batch or credential (M7/S16), and
the root audience-isolation suite pins cross-edge token rejection; the new
ops routes sit behind the same class-3 + `andpay:internal-admin` audience
gate as their neighbors. tenant-edge is a read-only tenant audience.

Step-up catalogue unchanged (`terminal-override`, `hold-release`,
`vendor-suspend`); flag-damage deliberately not step-up gated (consistent
with its risk class; flag if product disagrees).

---

## Migration, scope, and audit hygiene

- The branch adds ONE migration (`20260816120000_flag_damage_in_screen`,
  additive nullable column). Applied cleanly to the shared dev DB; all branch
  migrations date after main's newest, so the upgrade path from main's head
  is append-only. No table drops anywhere (the review brief's "removed
  damage-file tables" never existed to remove). The repo's posture is Prisma
  forward-only; there are no down migrations by convention. No
  `db push`/synchronize outside the sanctioned outbox test schema. A
  chain-from-empty replay was NOT re-run during this review (the five-agent
  budget death took the scratch-DB pass with it); the risk is one additive
  ALTER TABLE.
- Scope: `flagDamageOps` resolves the program server-side from the parent
  row, enters `tms_write` scope before writing, child inherits the parent's
  tenant/program; the two new reads run as `tms_ops_read` (platform-wide,
  N4); `projectShipmentToCases` re-pins the program per assignment. No SQL
  concatenation; no scope from a request body.
- Audit: the branch's only new mutation (flag-damage) co-commits an
  IDs-and-enums-only ALLOW 6e (remarks stay on the row; verified in the live
  ledger with both the admin and CS actors). Case transitions driven by
  facts write no 6e, matching the existing posture for fact-driven
  projections. Operator-visible history of a case: who flagged
  (`flagged_by`) and when (`created_at`) on the child, current status, both
  dispatch trails on the child's detail page; what is NOT visible anywhere is
  WHEN a case changed status (no transition timestamps exist; analytics is
  deliberately frozen). If case-age reporting is ever wanted, that is the
  case-status fact already parked with the corpus (submission Group C item 3).

---

## Test impact

Deleted with their subjects (correct under D-25): `services/tms/test/{damage,
per-group-damage, damage-resolution}.test.ts`, portal damage-upload tests.
Rewritten: `ops.test.ts` (preview/commit stripped, case-status kept),
`bank-file-adapter.test.ts`, `damage-reason.test.ts` (ingest-coupled cases
replaced by a flag-path deactivation test), `uploads-http.test.ts`, portal
upload suites, `apps/consumer/test/routing.test.ts` (topic table).
New: `flag-damage.test.ts` (8 scenarios incl. idempotent replay and
conflict-then-allowed-after-close), the 8-case `projectShipmentToCases`
describe, `flag-damage-http.test.ts`, `rbac-customer-support.test.ts`,
portal dispatch-detail (15), damage-cases (11), dashboards tile, nav gating.
The TC-<AREA>-<NN> catalogue named by the review brief is not present in this
repo; organization above follows the repo's own areas.

Missing tests, by risk:
1. Emitter-contract tests for consumed facts (the F1/F4 class): assert the
   OUTBOX payload of a collateral DELIVERED transition carries `asgnIds`, and
   that `replacement_raised` consumers use `replacedAsgnId`. These two would
   have caught both real bugs this review found.
2. Concurrent-flag race (F2), lands with the partial unique index.
3. Full-role 200s on the three newly gated previews (F5).
4. An end-to-end child lifecycle through fulfillment to DELIVERED/ACTIVATED
   (today the chain is covered piecewise; the pieces disagreeing IS finding
   F1).
5. Tile-versus-list reconciliation for D-31 (one query-level test).
6. CS role behavior across token refresh (role changes bind at refresh).

---

## Merge recommendation: MERGE AFTER FIXES

The branch is decision-faithful, well-tested at the unit and route grain,
and its one blocker is a cross-context contract miss, not a design flaw.
Sequence:

1. F1 (emitter enrichment + emitter-contract test + end-to-end close test).
   Required before merge: D-24 is otherwise only half-true for standee lines.
2. F4 (projector field fix + corrected test). Same emitter-contract family;
   cheap; restores a main behavior that has silently never worked.
3. F2 (partial unique index + 409 mapping + race test). Cheap insurance.
4. F5 and N1 ride along in the same pass.
5. F3 belongs to auth-edge, not this branch; fix on main or a follow-up
   branch, but before CS credentials are handed to real agents.
6. F6 pends the product answer below.

## Questions needing a product decision, not a code decision

1. The two damage tiles (F6): retire `damagedReplacementOpen`, or relabel it
   "replacements raised (all time)"? (Or rule in the case-status fact, which
   makes analytics able to say the true number.)
2. The CS read line (OQ-2, sharpened by the matrix): may customer_support see
   the full ICCID on device detail, the quarantine and exception queues, and
   the pool? Today: yes to all, by the guard-only read convention.
3. OQ-1: is flagging a replacement itself (damaged replacement) allowed?
   Built: yes, under the same one-live-case rule.
4. OQ-3: should In Progress mean batched instead of sent-to-vendor?
5. OQ-4: is surfacing `billable` on reports (no row hidden) the right reading
   of "Non-Billable exclusion in exports"?
6. D-15 duplicate-return detection is missing for ALL dispatches (main gap):
   does the damage rollout raise its priority, since replacement AWBs now
   coexist with original AWBs for the same merchant?
7. Flag-damage is not step-up gated; correct risk class?
