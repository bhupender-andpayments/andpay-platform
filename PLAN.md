# SoundBox Dispatch and Tracking System, Reconciliation and Build Plan

**Plan date: 12 August 2026** (the day of the product walkthrough that finalized D-1 to D-24).
Repo state audited: `main` at `de7bca8`, tree clean. Recency matters here: the dispatch-group
split (W-5), the two group-keyed Excels, GRID imposition (W-6), and the workflow workspace all
landed 10 to 12 August 2026, immediately before the walkthrough, so several older gap analyses
in `docs/plan/` are stale and this plan supersedes them for the walkthrough scope.

No code was written for this plan. Audit first, plan second, build only after review, per the
walkthrough instruction.

---

## 0. Reality checks found during the audit (read these first)

These are places where the walkthrough document's assumptions and the repo disagree. Where the
two conflict on requirements, the walkthrough wins. Where the walkthrough is factually wrong
about the repo, the repo wins and the item is recorded here.

1. **Stack.** The walkthrough says "Stack (locked): TypeScript, NestJS, MySQL, Redis, Docker,
   AWS." The repo is TypeScript, NestJS, **Postgres (Prisma, schema per context), Redpanda/Kafka,
   Docker, AWS**. Redis appears nowhere; MySQL appears nowhere. The walkthrough also says
   "follow existing repo conventions", which this plan does: the plan assumes Postgres and the
   existing rails stay. Flagged as Question Q1 rather than silently resolved.
2. **There is no Playwright harness and no TC-AREA-NN test IDs.** Repo-wide search returns zero
   hits for either. The suite is vitest, about 280 files, integration style against real
   Postgres, with prose test names carrying internal decision codes (W-5, D116, FR08-1).
   Section 6 lists test impact against the real suite instead. Question Q2 asks where the
   TC-IDs live (possibly an external QA document this repo has never seen).
3. **D-7 is already built.** The 11 August "dispatch-group split" (reviewed SOUND in
   `docs/plan/FINAL_REVIEW_dispatch_group_split_2026-08-11.md`) already mints separate Dispatch
   IDs per collateral group: `dispatchGroupsFor` in `services/tms/src/assignment.ts:143-154`
   creates a SOUNDBOX group and a COLLATERAL group per bank row, one `asgn_` id each, unique on
   `(source_event_id, dispatch_group)`. The walkthrough's biggest structural ask is largely done.
4. **The repo carries rulings the walkthrough now reverses.** Three were deliberate, reviewed,
   and in one case comment-locked:
   - M3 (10 Aug): one Dispatch ID may carry a second, collateral AWB. **Reversed by D-13.**
   - FR08-1: damage file quantity columns are authoritative. **Reversed by D-20.**
   - Inventory validation block marked "LOCKED BY BHUPENDER 2026-08-09, do not improve"
     (`services/fulfillment/src/device-inventory-adapter.ts:64-118`) requiring SIM No and
     Device QR. **Reversed by Workflow A step 3.**
   Per this repo's governance (CLAUDE.md, corpus-decision discipline), each reversal is listed
   in section 7 as owed to the architecture corpus before or alongside the build.
5. **Two latent defects were found in passing** (not walkthrough items, but they sit on
   walkthrough surfaces): a MAX_WAIT batching timer that fires on an empty pool was consumed and
   never re-armed, permanently disarming max-wait for that pool; and the journey view's exception
   tile filtered on `courier_status === 'RTO'`, a value no writer ever produces (the real value
   is `RETURNED`), so returned parcels vanished from all five delivery tiles. BOTH FIXED
   12 Aug 2026 (Phase 0b, commits `1ec5304` and `e9a5c83`).
6. **"Supertokens plugin".** Searched the plugin catalog: no such plugin exists (zero results).
   Noted and left, as instructed.

---

## 1. Codebase audit table

Verdicts: **OK** (implemented and correct per the decision), **CHANGE** (implemented but
contradicts a decision), **PARTIAL** (some of the decision present), **MISSING** (not
implemented). File references are the load-bearing ones, not exhaustive.

| Module / feature | Current behavior (as of 12 Aug 2026) | Decision(s) | Verdict |
| --- | --- | --- | --- |
| Ops device-inventory upload | `POST /ops/uploads/device-inventory` exists, server-parsed, audited, with upload ledger (`services/fulfillment/src/ops-device-inventory.ts:66`) | Workflow A | OK (channel exists) |
| Inventory validation | Requires Device ID regex, SIM No present plus regex, Device QR present, header whole-file reject (`device-inventory-adapter.ts:119-120,290-325`), plus duplicate-ICCID flagging (`intake.ts:185-200`) | Workflow A step 3 | CHANGE (over-validates; reverses a locked ruling) |
| Inventory duplicate check | `ON CONFLICT (device_serial) DO NOTHING` plus in-file dup flag (`intake.ts:164-167,207-223`); `deviceSerial @unique` | Workflow A step 3 | OK |
| Inventory pool | `unit` table, rows born IN_STOCK; ops read plus InventoryPage | Workflow A step 4 | OK |
| System-generated Soundbox ID | Does not exist; only internal `unit_` uuid and the vendor Device ID | Workflow A step 4 | MISSING (needs ID ruling, Q4) |
| Pool validates vendor returns | Unknown serial and already-consumed serial both quarantine (`return-sheet.ts:249-279`) | Workflow A step 5 | OK |
| CWD-to-vendor movement tracking | None; `unit.location` dormant, never written | D-1 | OK (by absence) |
| Pool re-entry / repair flow | None; DAMAGED/RETURNED terminal, no exit; replacement is a new assignment | D-2 | OK |
| Vendor intake channel | `POST /vendor/intake` still births units in parallel with the ops upload, with different strictness | Workflow A (actor: Ops) | CHANGE or ruling (Q5) |
| Bank file upload actor | Class-3 ops permission; tenant edge has no upload route at all | D-3 | OK |
| QR String / VPA mandatory | Both structurally required and per-row validated (`bank-file-adapter.ts:38,47`; `ingest.ts:137`); but the Annexure B header signature omits QR String, so a missing column degrades to per-row rejects | D-4 | OK / PARTIAL |
| Duplicate VPA rule | Gate only when soundbox requested; held to quarantine naming the original; Soundbox=No duplicates tagged ADDITIONAL on the same merchant (`ingest.ts:307,391-400`; `assignment.ts:225-228`) | D-5 | OK (two edge refinements) |
| One soundbox per VPA, Y/N | Boolean end to end, Y/N normalized, no quantity | D-6 | OK |
| Two Dispatch IDs per row | W-5 split delivered: one `asgn_` per group, group on fact/pool/Excel/artifacts; lot counting corrected to request grain | D-7 | OK |
| Review queue: exists | `quarantine_row` with `detail` JSONB naming the original; partial accept; resolve action; QuarantineTab; preview equals commit | D-8 | PARTIAL |
| Review queue: colliding batch number | Not shown; original named as `asgn_` id or row ref only; batch lives cross-context in fulfillment | D-8 | MISSING |
| Review queue: Close action | Does not exist; the only action re-drives a corrected row | D-8 | MISSING |
| Review queue: cure scope | Full 18-field free-form re-key; original row not persisted (`raw_row` stored as `redacted:bank_request`), so the form starts empty | D-8 | CHANGE |
| Queue expiry / TAT | None anywhere | D-9, O-3 | OK |
| Batching config scope | `(tenant, program)` keyed with tenant and global tiers; never per-bank; admin-tier API write; read-only UI tab; a per-program override tier is live surface D-10 does not grant | D-10 | PARTIAL |
| Batch trigger: lot size | Event-driven count of DISTINCT source_event_id vs min lot | D-10 / trigger logic | OK |
| Batch trigger: max wait | Timer measures time since pool creation or last batch, not oldest-entry age; empty-pool fire permanently disarms the timer (defect) | trigger logic | CHANGE plus DEFECT |
| Manual trigger / hold | Trigger with mandatory reason plus audit (M4); hold/release audited but capture no reason | trigger logic | OK / PARTIAL |
| QR image generation | Vector PDF per artifact from the bank QR String; qrcode plus pdf-lib; bank-qr package repairs the known GSCB escaping defect at the two artifact boundaries | Workflow B step 9 | OK (PDF, not raster image; Q8) |
| Bank logo source | `bank_composition_config.logo_master_ref` keyed (bank, branch); the identity Bank Master has no logo field | Workflow B step 9 | PARTIAL (two masters; Q9) |
| One image per merchant per type | ONE_PER_PAGE merge collapses to one collateral page per merchant; storage keeps up to two collateral artifacts, and GRID_3X2 bakes N copies into the print run itself | D-11 | OK after T7.1 (grid is a SANCTIONED exception, Q10 ruled 13 Aug 2026; the sheet now names which surface owns the copy count) |
| Dispatch package shape | Two group-keyed Excels (references only, no embedded images) plus two merged PDFs, one page per merchant per group; ops and vendor download surfaces | D-12 | OK after T7.2 (Q11 ruled 13 Aug 2026: four files per dispatch, in two pairs, image halves bundled, which is what the platform already produced; the vendor portal offered only two of the four and now offers all four) |
| Sent to Print Vendor | `dispatch_state = SENT_TO_VENDOR` stamped when the package is composed (available), not when the vendor pulls | D-12 | OK (timing nuance noted) |
| Return file fields | Dispatch ID, optional-value Device ID, AWB, courier; **no dispatch date column** (server clock used); **no AWB format per courier** (deliberately deferred) | Workflow B step 12 | PARTIAL |
| One AWB per Dispatch ID | Collateral leg capped at one; **soundbox leg unenforced** (a second unpaired device plus new AWB for the same Dispatch ID is accepted and births a second shipment); legacy null-group rows documented to carry two AWBs | D-13 | CHANGE |
| Partial returns | Record-by-record on the workbook path, unmatched rows keep SENT_TO_VENDOR; but the vendor-portal JSON path still rejects a whole file on one bad row | D-14 | OK / PARTIAL |
| Duplicate return records | No detection (see D-13 gap); fulfillment queue lacks a `detail` column, has no return-row cure (its only cure re-drives an intake sheet), and no explicit Close | D-15 | MISSING |
| Post-dispatch lifecycle | Delivery ladder correct per shipment with append-only trail; but activation is a scalar overwrite on a shared linear `pipeline_state`, no Request Sent to CWD status exists, no activation history, and activation is hard-gated on Delivered in four places (`ops.controller.ts:684-709` 409s not-delivered; worklist SQL; UI disable; pinning test) | D-16 | CHANGE (the core contradiction) |
| Standee-only terminal | COLLATERAL rows refused activation, kept off the worklist, rendered not-applicable | D-16 | OK |
| Dispatch detail UI | No per-dispatch page; journey view is batch-grained and linear (8 stages, activation strictly after delivery); shipment status trail readable only on the tenant edge | D-16 | MISSING |
| Courier tracking channels | Manual one-by-one ops correction: built. Batch status file: built but JSON, vendor-credential route, mode-gated; **no ops-side upload**. Webhook receiver: **already built and routed** (walkthrough says Phase 2). Aggregator pull: not built (correct) | D-17 | CHANGE (shape) |
| Failed/Returned dead end | RETURNED terminal, no RTO/re-dispatch flow (correct); but FAILED is deliberately non-terminal, and a step-up-gated `overrideTerminal` can reopen terminals | D-18 | PARTIAL (Q14) |
| Activation report | `GET /ops/reports/activation` with CSV; carries device IDs but **no SIM No** (unit.sim_no never projected to analytics) | D-19 | PARTIAL |
| Activation write path | Built end to end (single record): route, TMS write, fact, unit fold, analytics fold; ManualDevicePort on the manual path. Older "unwired" notes are stale, and four stale comments say the opposite of the code | D-19 | OK (single record) |
| Bulk mark Activated | Deliberately refused on record ("NO MARK-ALL BUTTON, deliberately", `ActivationStage.tsx:12-18`); no multi-select, no bulk write anywhere | D-19 | MISSING (reversal) |
| Activation Excel upload | No upload kind, no permission, no route | D-19 | MISSING |
| Direct CWD API | Deferred behind the device port | D-19 | OK |
| Damage file fields | bank code, VPA, damage reason, bank remarks, ship-to all required; **merchant name and AND-side remarks absent**; ship-to is an extra required field the decision does not list | Workflow C step 1 | PARTIAL (Q16, Q17) |
| Damage quantity columns | soundbox / standeeCount / stickerCount exist and override the clone (FR08-1) | D-20 | CHANGE (reversal; couples to O-1) |
| Damage validation | Four checks beyond VPA-exists: bank-code plus VPA must resolve exactly one request; reason must match the active reason master; empty item set quarantines; and the exact "named collateral must exist on the original" check D-21 forbids | D-21 | CHANGE |
| Damage reason master | Four seed reasons; **no Others**; table is preserved master data, so the fix is an additive migration | D-22 | MISSING |
| Damage linkage | Non-billable replacement linked per group to its own-group original; bidirectional in analytics | Workflow C step 4 | OK |
| Replacement pipeline | Same demand fact, unconditional artifact regeneration, normal batching, manual trigger available, no expedite lane; QR value cloned from the original (artifact regenerated, payload reused) | D-23 | OK (Q18 on payload) |
| Damage case lifecycle | Overlay column with exactly Open / In-Progress / Closed; but transitions are manual-only (nothing advances on replacement progress), no transition graph, the file can seed any initial state, no fact emitted (analytics frozen at RAISED), and no portal UI | D-24 | PARTIAL |

---

## 2. Gap-by-gap reconciliation, keyed by decision ID

Workflow A items are covered in the Phase A task list (section 4) since the walkthrough asked
for the inventory workflow as its own body of work.

**D-1 (no CWD-to-vendor tracking):** Code complies by absence. No change. Optionally drop the
dormant `unit.location` column from the ops read to stop advertising a movement concept.

**D-2 (pool entry exactly once, no re-entry):** Complies. `deviceSerial @unique`, terminal
states have no exit, no repair path exists. No change.

**D-3 (actor is Ops):** Complies. No change.

**D-4 (QR String mandatory):** Complies at the canonical layer. One hardening change: add
`QR String` to the Annexure B header signature so a file missing the column fails structurally
with one error instead of 360 per-row rejects (`services/tms/src/bank-source-profile.ts:66,99`).

**D-5 (conditional duplicate rule):** The core rule is built exactly as ruled (matches the
10 Aug M1 ruling). Two refinements: (a) the collision scan today matches originals that have no
soundbox, so a soundbox row colliding with a standee-only history is held spuriously; add a
soundbox predicate to `seedKnownVpaOriginals` (`ingest.ts:244-255`) and the in-file seed. (b)
post-split, prefer the SOUNDBOX sibling when naming the original so the operator sees the
soundbox dispatch, not the collateral consignment.

**D-6 (one soundbox per VPA, Y/N):** Complies. No change. (Uniqueness is gate-enforced, not a
DB invariant; acceptable and consistent with O-2's deferral.)

**D-7 (two Dispatch IDs):** Delivered by the W-5 split, reviewed SOUND, minors closed. Residuals:
the 10 Aug ledger lines that framed the ask as "print the single id" are stale and need a
superseding note; a soundbox-only row mints one ID, not two (correct reading of D-7, but any doc
saying "always two" is wrong).

**D-8 (review queue, close or cure):** The queue, partial accept, naming-the-original, audit,
and cure-reprocess loop exist. Four gaps to build: (1) a first-class **Close** action (resolve
without re-ingest, retained in archive, distinguishable from cured); (2) **show the held row's
own content** so cure is an edit, not an 18-field re-key. Today `raw_row` is deliberately
redacted; persisting a structured row snapshot needs a PII/S7 ruling (Q6); (3) **constrain the
cure to the two legal edits** (flip Soundbox to No, or correct the VPA) for duplicate-reason
rows; format-reason rows keep the free cure (the queue is shared, so the action set must be
reason-dependent, Q7); (4) **surface the colliding record's batch number**. Batch lives in
fulfillment, quarantine in tms, so this is a projection/fan-out at the edge or an analytics
read, never a cross-context DB read.

**D-9 (no expiry/TAT):** Complies. Nothing to remove. O-3 noted for Phase 3 (product phase),
no design constraint today.

**D-10 (tenant-scoped global config):** Storage and resolution already tenant-scoped with a
global tier, never per-bank. Changes: reject `programWire` on the write path (the live
per-program override tier is surface D-10 does not grant), or record it as an approved forward
hook (Q12); and give the admin a portal write UI (today the tab is read-only and the write is
API-only, admin-tier).

**Trigger logic (Workflow B step 8):** Lot-size and hold logic comply. Two changes: fix the
empty-pool disarm defect (re-arm on the zero-claim path); and re-anchor max-wait to
oldest-pending-entry age as the walkthrough words it, replacing time-since-last-batch (confirm
intent, Q13). Manual trigger complies (reason plus audit). Manual hold needs a reason field
(nullable domain column, edge-validated, off the 6e record, mirroring the M4 trigger-note
pattern).

**D-11 (one image per merchant per type):** ONE_PER_PAGE delivery complies. GRID_3X2 mode bakes
copy counts into the PDF print run, which contradicts "vendor prints it N times"; either retire
grid mode, keep it as an explicitly sanctioned exception, or leave it vendor-selectable with the
ruling recorded (Q10). WITHDRAWN 13 Aug 2026: the "optional cleanup" this paragraph proposed,
dropping the second collateral artifact for both-products merchants, rested on that artifact
never being delivered, and it is delivered. GRID_3X2 prints it as its own material run and the
Excel carries its reference under either layout. See the Phase 7 task list and Q10.

**D-12 (two Excels plus separate images):** Two group-keyed Excels with reference-only cells:
built. Images ship as two merged PDFs, one page per merchant per group, not as per-merchant
image files; if the walkthrough means separate files (or a zip of per-merchant PDFs/PNGs), that
is new work (Q11). "Sent to Print Vendor" stamping complies.

**D-13 (one AWB per Dispatch ID):** Three changes: (1) enforce on the soundbox leg: before
pairing, reject a device row whose Dispatch ID already has a paired unit, into the review queue
(new reason code, e.g. `duplicate_return_for_dispatch`); (2) retire the collateral second-AWB
mechanism (M3) for group-split rows: a COLLATERAL Dispatch ID takes its own single AWB through
the same path as any other line; (3) rule the legacy scope: pre-split null-group rows are
documented to allow two AWBs, and `pending_pool_entry.collateral_shipment` plus the additive
shipment-fact fields exist for them (Q15: retroactive or grandfathered). This is a reversal of
the M3 corpus submission item and must ride the next corpus submission.

**D-14 (partial returns, record-by-record):** Workbook path complies, including untouched rows
keeping SENT_TO_VENDOR. One change: the vendor-portal JSON path still rejects a whole file on
one shape-invalid row; align it to per-row rejection.

**D-15 (duplicate returns to the review queue):** Detection does not exist (the D-13 soundbox
gap). Build: the detection above lands the row as a fulfillment `intake_exception`; add a
`detail` payload naming the existing pairing (device serial, AWB) for operator context; add a
**return-row cure** (today the only cure re-drives an intake sheet, which is wrong for return
disputes) and an explicit **Close**, mirroring the D-8 action pair.

**D-16 (parallel branches):** The structural change of this build.
- Delivery branch: already correct per shipment (ladder plus append-only trail). Keep.
- Activation branch: introduce per-Dispatch-ID activation state with exactly two statuses,
  REQUEST_SENT_TO_CWD and ACTIVATED, and an append-only activation status-event trail (the
  activation report generation event is what sets REQUEST_SENT_TO_CWD). New column plus table in
  TMS or fulfillment per corpus ruling; new statuses are enum tokens, no new ID kinds.
- Remove the delivered-gate on activation in all four places: the 409 in
  `apps/ops-edge/src/ops.controller.ts:684-709` (keep the COLLATERAL not-activatable 409), the
  worklist SQL predicate, the UI disable, and the pinning test.
- Analytics: replace the single `pipeline_state` ordinal with two independent axes (delivery
  status, activation status) folded separately; today an early ACTIVATED permanently masks
  DELIVERED in `pipeline_state`.
- Unit lifecycle: decouple ACTIVATED from the linear post-DELIVERED ladder so
  activation-before-delivery is recordable without losing the later delivery transition.
- UI: a per-dispatch detail view rendering the two branches side by side with the full status
  history underneath; requires an ops-edge status-trail route (the read exists but is currently
  tenant-edge only). The batch-grained 8-stage rail stays, with stages 7 and 8 rendered as
  parallel rather than sequential.

**D-17 (courier tracking, Phase 1 shape):** Manual path complies. Changes: (1) build the
**ops-side** batch status upload for the courier's morning file, spreadsheet-shaped (CSV/Excel),
reusing the existing `ingestStatusFile` domain seam so a Phase 2 webhook/aggregator source slots
in without rework (the seam already proves this: the webhook mapper is a port); (2) rule the
already-built vendor webhook receiver: keep live, or gate off until Phase 2 (Q19). The existing
vendor JSON batch route can stay for integrated couriers; it does not satisfy the emailed-file
story.

**D-18 (Failed/Returned dead end):** RETURNED terminal and no-RTO-flow comply. Two rulings
needed rather than blind changes (Q14): FAILED is deliberately non-terminal today (a failed
attempt can move forward to DELIVERED, which matches real courier behavior); and
`overrideTerminal` is a step-up-gated, audited correction tool, not a product reopen flow.
Recommendation: keep both, record them as sanctioned exceptions to D-18. Also fix the RTO
vs RETURNED vocabulary defect so returned parcels are visible again.

**D-19 (activation recording):** Single-record write path is built (stale comments to clean).
Build: (1) add SIM No to the activation report (project `unit.sim_no` into analytics; the data
is captured at intake already); (2) bulk-select mark-Activated (reverses a recorded deliberate
absence; the walkthrough explicitly rules it in); (3) the activation Excel upload (Device IDs
plus status) as a new ops upload kind through the same single-record write in a loop, with
per-row rejects into the standard result shape. Note D-16 must land first or the delivered-gate
blocks bulk marking of undelivered-but-activated rows.

**D-20 (no quantity in damage file):** Remove the three quantity columns from the damage
mapping and the items override. This reverses FR08-1 (owed to corpus) and, critically, removes
the only mechanism that decides WHICH collateral is damaged, which is exactly O-1. The removal
must land behind the O-1 seam (section 5), not before it exists, or every damage row blindly
replaces the merchant's full original order.

**D-21 (only VPA-exists validation):** Reduce validation to VPA existence plus the reason
master lookup it needs for linkage. Keep quarantine (not hard reject) as the failure shape.
Open sub-questions the walkthrough must answer before the code changes (Q16): does VPA-exists
mean "any assignment carries this VPA" (current reachable meaning) and is the bank-code
predicate dropped (VPA is not unique across banks in this schema); is the reason-master match
still allowed (D-22 implies the master stays, and linkage needs it under some O-1 candidate
resolutions); the collateral-must-exist check is removed per the explicit ruling (standee
damage for a merchant who never had a soundbox must pass; note the current code mostly passes
this case via the orphan-collateral rule, and the strict failure is rarer than the walkthrough
implies, but the check goes regardless).

**D-22 (Others reason):** Additive migration seeding an `others` row (the table is preserved
master data, so a data patch would not survive fresh provisioning). Pair with the free-text
remarks so Others is usable (the AND-side remarks column from Workflow C step 1, currently
missing entirely).

**D-23 (unconditional replacement pipeline):** Complies. One confirmation (Q18): the QR
artifact is regenerated but the QR payload is cloned from the original (same VPA, so this looks
correct); confirm the ruling means artifact, not payload.

**D-24 (complaint-style overlay):** Shape complies (single overlay column, exactly three
values). Build: automate the two transitions (Open to In Progress when the replacement enters
the pipeline; In Progress to Closed when the replacement reaches its terminal state, which
post-D-16 means Activated for soundbox groups and Delivered for collateral groups, Q20 confirms
the exact terminal predicate); emit a fact on transition so analytics unfreezes
`replacementStatus`; normalize the label to the walkthrough's "In Progress" wording at the API
boundary; stop seeding case status from the file's `deliveryStatus` column (remove the column
with D-20's); keep manual override as an ops correction; and add the damage-case management
screen (list exists at the edge; no portal UI).

**O-1 (which collateral is damaged):** Unresolved, and D-20 makes the current fallback
(replace everything the original shipped) the only behavior. Section 5 defines the seam.

**O-2 (composite merchant uniqueness, Phase 2):** Not built, correctly. The seam already
exists and must be preserved: merchant identity is derived in exactly one place
(`bankMerchantReference = v1:vpa:<lowercased vpa>` in `services/tms/src/bank-source-profile.ts:80`,
resolved in `services/identity/src/project.ts:124-132`), and the 10 Aug ledger records VPA as
"a dedup hint, never identity" (Decision 116). Rule for all new code in this plan: never join
on VPA as merchant identity; always resolve through the identity projection.

**O-3 (queue expiry, Phase 3):** Nothing exists, nothing to do. Noted only.

---

## 3. Build sequence overview

Phases are dependency-ordered. Sizing: S (about a day or less), M (a few days), L (a week-ish).
Every task is written to be independently reviewable and to show visible progress (a working
screen, a passing gate, an evidence artifact) at its end, per the walkthrough instruction to
keep tasks short.

Status: **Phase A, Phase 0b, and the unblocked work in Phases 1 and 2 are complete** on branch
`build/workflow-a-inventory` (10 commits, unpushed, unmerged), each behind a green root gate
(277 files / 2196 tests, lint and typecheck clean).

- Phase 1: T1.1 and T1.3 landed. T1.2, T1.4, T1.5 are ruling-blocked (Q15, Q21, Q22); T1.6
  shares the cure/close pattern with T2.2b.
- Phase 2: T2.2a (Close), T2.3a (soundbox sibling), T2.4 (QR String) landed. T2.1 is blocked on
  Q6, T2.2b on Q7, and T2.3b (colliding batch number) is not started.
- Phase 3: T3.2 (hold reason) and T3.3 (max-wait re-anchor) landed. T3.1 is blocked on Q12 and
  T3.4 is not started.
- Phase 4: DONE, all six tasks, 13 Aug 2026. Built in dependency order rather than the numeric
  order first listed here: T4.2 removes the gate that made activation-before-delivery
  impossible, so it had to land after T4.4 and T4.3, which are the two places that would
  otherwise have lost data the moment it did.
- Phase 5: T5.1 (ops courier upload), T5.2 (Q19 ruling, no code), T5.4 (bulk mark-activated)
  and T5.5 (activation file) landed. T5.3 (SIM No on the activation report) is BLOCKED and
  escalated: the ICCID is deliberately granted to no read role pending an architecture PII
  ruling, so projecting it would cross a security invariant. See Q25.
- Phase 6: T6.1 (the O-1 seam), T6.2, T6.4 and T6.6 landed in full; T6.3 and T6.5 landed in
  part. T6.3's remainder is blocked on Q16; T6.5 leaves the COLLATERAL close manual (Q26) and
  emits no case-transition fact, so analytics still cannot unfreeze `replacementStatus`.
- Phase 7 OPENED AND CLOSED 13 Aug 2026, both gating questions answered on the day. T7.1 landed
  on Q10 (grid sanctioned as an explicit D-11 exception), commit `237b9a4`, closing the double
  copy-count instruction the sanction exposed. T7.2 landed on Q11 (four files per dispatch, image
  halves bundled), commit `65a86b7`, which needed no package change and one door change: the
  vendor portal offered two of the four files while the images route sat live and authorized at
  the edge with nothing calling it. T7.3 is closed as will-not-do: its premise (a second
  collateral artifact rendered and never delivered) is false under GRID_3X2, which delivers it as
  its own material run, and false on the Excel in BOTH layouts, which ships its reference
  regardless. The guard recording that coupling is commit `ebc923c`.

Gate notes, recorded rather than smoothed over. The first Phase 2 gate run showed three 5-second
TIMEOUTS in `test/audience_isolation_cross_edge.test.ts`, a file none of these changes touch and
which passed in the two preceding gates. The Phase 3 gates then failed a DIFFERENT file each
time: `analytics/test/watermark.test.ts` (a hardcoded watermark instant overwritten by a live
one) on one run, then `analytics_rail.test.ts` (audit seq 2, not 1) plus two
`toBeGreaterThan` timestamp comparisons on the next. Every one of them passed in isolation
immediately afterwards. A failing set that MOVES between runs on files the change never touched
is the shared-DB contention cluster (`docs/plan/OPEN_ITEMS.md` section D), not an invariant
breach. Two specific smells worth naming for whoever fixes it: suites that assert on absolute
timestamps or on a global sequence number cannot survive a neighbour writing to the same schema,
and assertions comparing a Postgres-written timestamp against a Node-side marker also ride on
host-versus-container clock skew. Fix it as isolation work; do not keep buying passes with
re-runs. The Phase 7 gate added one more of the same shape: a 40P01 deadlock in
`apps/ops-edge/test/batching-config-http.test.ts`, a file the change never touches, between a
TRUNCATE waiting on AccessExclusiveLock and a neighbour's RowExclusiveLock. It passed alone and
the whole gate then passed clean at the identical tree, which is the discriminator.

Dependency spine:

```
Phase 0 (rulings + ledger)  ->  everything
Phase 0b (defect fixes)     ->  DONE
Phase A (inventory, frozen) ->  DONE
Phase 1 (returns + D-13/14/15) -> needs Phase 0 rulings Q15, Q6/Q7 pattern
Phase 2 (review queue D-8)  -> shares the close/cure pattern with Phase 1
Phase 3 (config + batching) -> independent after 0b
Phase 4 (D-16 state split)  ->  DONE (gates Phase 5 and Phase 6, both now unblocked)
Phase 5 (courier + activation ingestion, D-17/D-19) ->  DONE except T5.3 (blocked on Q25)
Phase 6 (damage, D-20..D-24) ->  DONE except T6.3 (Q16) and T6.5's collateral close (Q26)
Phase 7 (package/QR nuances, D-11/D-12) ->  DONE (T7.3 closed as will-not-do)
```

---

## 4. Phase task lists

### Phase 0: Rulings and ledger (no code) - size S, blocks everything

- T0.1 (S): Record D-1 to D-24 verbatim in `docs/plan/` as the 12 Aug walkthrough ledger,
  with explicit supersession notes against: M3 (two AWBs), FR08-1 (damage quantities), the
  locked inventory-validation block, TASKLIST_2026-08-08 D-2 scope, and the stale 10 Aug
  "print the single dispatch id" lines. List the corpus-owed items (section 7).
- T0.2 (S): Get answers to the questions in section 8. Q4, Q6, Q10, Q11, Q15, Q16 gate specific
  tasks below; each blocked task names its question.

### Phase 0b: Defect fixes on walkthrough surfaces - DONE 12 Aug 2026

- T0b.1 (S) DONE, commit `1ec5304`: the zero-claim path in `triggerBatchWithinTx` now re-arms,
  but only for a MAX_WAIT fire (the only reason that consumes a timer); both exits share one
  supersede-and-re-arm function. Three tests: structural re-arm, behavioral proof a later
  entry is still swept, and a pin on the deliberate LOT_SIZE asymmetry. Verified failing
  before the fix.
- T0b.2 (S) DONE, commit `e9a5c83`: `'RTO'` corrected to `'RETURNED'` in the exception tile and
  the portal pill map; the fixture that agreed with the bug now uses the writer's vocabulary,
  plus a guard that a RETURNED row lands in exactly one courier bucket, never none.

### Phase A: Workflow A, inventory ingestion - DONE 12 Aug 2026

Standalone: no dependency on any other phase; nothing else depends on it except T1.x return
validation, which already works against the pool. Evidence:
`evidence/workflow_a_phase_a_evidence.md`.

- TA.1 (M) DONE, commit `8b28ed6`: validation reduced to the frozen rule. Device ID presence is
  the only row check; Sim No and Device QR are optional pass-through columns; the Device ID and
  Sim No regexes are gone and the 2026-08-09 format lock is replaced by a superseded-lock note
  citing the walkthrough. A missing Device ID COLUMN stays a whole-file structural reject (Q3,
  recommended default taken). Portal copy, the row-error union and every pinned test moved with
  it.
- TA.2 (S) DONE, commit `6a339c7`: the ICCID-conflict detection moved behind its own switch and
  the ops upload no longer passes it, so a duplicate ICCID is stored as sent with no
  review-queue noise. The duplicate SERIAL check the frozen rule allows stays on both doors.
- TA.3 (M) DONE, commit `407287b`. Q4 ruled: the existing `unit_` wire id IS the
  system-generated Soundbox ID (minted at registration, typed through `@andpay/ids`, already on
  the wire), so nothing was invented and no migration was needed. The inventory table now shows
  it beside the manufacturer Device ID, which stays first as the value read off the box.
- TA.4 (S) DONE, commit `407287b`. Q5 ruled: `POST /vendor/intake` stays open as a second
  sanctioned channel. Their validation is deliberately asymmetric (the walkthrough binds the ops
  door only; the vendor door keeps its class-6 D103b schema contract and ICCID detection), which
  `intake.ts` now states, along with what both must keep sharing. That shared part gained its
  first pin: a cross-door test proving a serial already in the pool via the ops upload does not
  mint a second unit through the vendor door (D-2).
- TA.5 (S) DONE: live probe (`evidence/workflow_a_probe.mjs`) through the real service
  functions. 150/150 BRD rows into the pool at IN_STOCK; a duplicate re-upload flags 150 and
  accepts 0; a return sheet still quarantines an unknown serial and a consumed one.

### Phase 1: Returns and the one-AWB model (D-13, D-14, D-15) - IN PROGRESS

- T1.1 (M) DONE, commit `cf882f5`: the device leg now caps a dispatch id at one AWB. A second
  unpaired serial against an already-served dispatch quarantines as
  `dispatch_already_has_device` (D-15) instead of birthing a second shipment, and
  `intake_exception` gains a nullable `detail` jsonb (migration `20260812100000`, mirroring
  `tms.quarantine_row.detail`) carrying the incumbent shpt id and AWB. Deliberately NOT the
  device serial: this table has never stored serials, and a test asserts neither serial reaches
  any column. The ops queue renders it as an "Already shipped as" column. Verified failing
  before the fix.
  NOTE ON D-13 SCOPE, worth reading before T1.2: with this landed, every GROUP-BEARING dispatch
  id already has exactly one AWB, because the two W-5 shape gates plus the two caps cover all
  four cases. The only remaining two-AWB shape is a pre-split null-group row, which is exactly
  what Q15 asks about. D-13's count is satisfied; T1.2 is now a modelling cleanup, not a
  correctness fix.
- T1.2 (M): Retire the collateral second-AWB path for group-split rows: serial-less rows
  targeting a COLLATERAL Dispatch ID become that dispatch's single AWB through the standard
  shipment birth; the `collateral_shipment` link and the additive fact fields stop being
  written for new rows. Legacy handling per Q15. BLOCKED on Q15, and note it overlaps Phase 4:
  the payoff is that a COLLATERAL dispatch can reach DELIVERED (its D-16 terminal), which needs
  the analytics fold that T4.3 rewrites. Sequencing it after Phase 4 avoids doing that fold
  twice.
- T1.3 (S) DONE, commit `92fe79e`: the JSON return path moves to per-row rejection. Envelope
  problems stay whole-file (matching the workbook adapter's structuralErrors); row problems
  become `invalidRows`. Row-level S8 strictness is unchanged because the strict parse is called
  per row and only its failure is classified. New code `invalid_row_shape` for JSON-only failure
  modes; the workbook path never emits it.
- T1.4 (S): Decide-and-do per Q21: dispatch date column on the return sheet (vendor-reported)
  vs server clock. If ruled in: new optional column, parse, and `shpt.dispatch_date` sourced
  from it.
- T1.5 (M): AWB format per courier: per-courier pattern on the courier/vendor master, validated
  at return ingest, quarantine on mismatch. Needs the pattern source ruled (Q22).
- T1.6 (M): Return-row cure and Close for fulfillment exceptions: a resolve endpoint that
  re-drives a corrected RETURN row (today only intake sheets can be re-driven), plus an explicit
  Close that resolves without re-ingest. Mirrors T2.2.

### Phase 2: Review queue completion (D-8) - IN PROGRESS

- T2.1 (M): Held-row context. BLOCKED by Q6 (PII posture of persisting the row snapshot). Once
  ruled: persist the structured row (or the minimal cure-relevant fields) on `quarantine_row`,
  render it in the queue, and pre-fill the cure form. This kills the 18-field re-key.
- T2.2a (M) DONE, commit `7408479`: the **Close** action exists. `closeQuarantineRow` archives a
  held row with no ingest; `quarantine_row.resolution` ('cured' or 'closed', CHECK constrained,
  migration `20260812140000`) tells the two apart in the archive, with pre-existing resolved rows
  deliberately NOT backfilled. Its own permission and operation string so the 6e can distinguish
  the two claims. Race-safe against a concurrent cure (`resolved_at IS NULL`, reported as
  `closed: false`). The portal offers both actions and confirms the close first.
- T2.2b (M): the LEGAL-EDIT CONSTRAINT on cure (flip Soundbox to No, or correct the VPA, for
  duplicate-reason rows only). STILL BLOCKED on Q7, which is only about the reason-dependent
  scoping, not about Close.
- T2.3a (M) DONE, commit `86c778c`: a duplicate hold now names the SOUNDBOX sibling rather than
  the standee consignment, ranked by the request's own age and then the leg, so an earlier
  request can never be outranked. NOT done, and deliberately: the soundbox predicate on the
  original-matching scan. D-5's own wording is "if VPA already exists in the system", which is
  exactly what the code does, so narrowing it is a new ruling, not a fix. See Q23.
- T2.3b (M): the colliding record's BATCH NUMBER on the queue row. Not started. Cross-context
  (batch lives in fulfillment, quarantine in tms), so via an analytics read or an edge fan-out,
  never a DB join.
- T2.4 (S) DONE, commit `c4f9866`: a profile may declare `requiredSourceColumns`, and Annexure B
  declares `QR String`. A GSCB file missing it is now rejected whole, naming that column, instead
  of degrading to one reject per row. Deliberately NOT added to the signature, which would have
  unclaimed the file and produced a wall of canonical-field errors instead.

### Phase 3: Config and batching posture (D-10, trigger logic) - IN PROGRESS

- T3.1 (S): Reject `programWire` on the batching-config write (or record the tier as an
  approved hook, per Q12). STILL BLOCKED on Q12. Not started.
- T3.2 (S) DONE, commit `d1b67c1`: manual hold captures a reason. `holdRecord` REQUIRES a
  non-blank one and validates it before any transaction opens, so a rejected reason leaves the
  row POOLED rather than rolling one back; capped at the trigger-note length, bound as a
  parameter, never logged, off the 6e record. `holdEntryWithinTx` takes it as OPTIONAL and the
  absence is a meaning, not an omission: the event-driven caller has no human behind it and
  legitimately holds with none, which stores NULL. Migration `20260812160000`. The pool read
  projects `hold_reason`; the portal's Hold button now arms a form.
- T3.3 (M) DONE, commit `9bb2a00`: max wait now measures the OLDEST POOLED ENTRY's age, per
  Q13's literal wording, not the pool's idle stretch since its last batch. The due timer became
  a wake-up: if the oldest entry has not reached max wait, the firing timer is superseded and
  re-armed for exactly the remainder, and the pool is left alone. The age is measured against
  the CALLER's `now`, the same clock that decided the timer was due, never SQL `now()`, or a
  caller sweeping with a future clock (the scheduler's own test) would find every timer due and
  every entry too young and nothing would ever batch. An empty pool still falls through to
  `triggerBatch`, which re-arms the timer it consumes (T0b.1); deciding "not due" here would
  duplicate that re-arm and leave two pending timers.
- T3.4 (M): Batching-config admin write UI on the read-only master-data tab (admin-tier).
  Not started. Not blocked, but it writes the same config surface T3.1 is arguing about, so it
  is cheaper after Q12 is answered than before.

### Phase 4: The D-16 state split - DONE 13 August 2026

Built in DEPENDENCY order, not the numeric order this plan first listed. T4.2 removes the gate
that made activation-before-delivery impossible, so it had to land AFTER the two places that
would otherwise lose data the moment it did: the unit ladder (T4.4) and the analytics rollup
(T4.3). Landing T4.2 second, as numbered, would have opened a window where an early activation
silently destroyed a device's delivery record and a batch's delivered count. Actual order:
T4.1a, T4.1b, T4.4, T4.3, T4.2, T4.5.

- T4.1a (M) DONE, commit `3c803c9`: the activation axis exists. `assignment.activation_status`
  carries the latest of D-16's two statuses, CHECK constrained, with NULL a real state (nobody
  has asked the CWD yet) rather than an unknown; `assignment_activation_event` is the
  append-only trail, modeled on `shpt_status_event` line for line where it fits, because D-16
  makes the two branches siblings. The trail and the column answer different questions, so one
  is unconditional and the other forward-only: chasing the CWD twice writes two rows, and a
  stale request-sent cannot walk an activated record backwards. Migration `20260813100000`.
  Deliberately NO fact: a new topic is a corpus decision and needs out-of-band provisioning
  (S23), so REQUEST_SENT_TO_CWD is TMS-local state read by the edge. Section 7 item 4 stands.
- T4.1b (M) DONE, commit `8c935e5`: the second writer. `requestActivationOps` plus
  `POST /ops/assignments/request-activation`, its own permission and operation string. Takes a
  LIST because a send is a batch; one reported instant for the whole send; an unresolvable id is
  reported, not thrown on, so a stale worklist costs one row and not the other twenty-nine; the
  6e names only the ids actually acted on. Implemented as a POST rather than a side effect of
  the report GET, which is what D-16's literal wording says. See Q24.
- T4.4 (M) DONE, commit `6adb2db`: `unit.status` keeps the DELIVERY axis only and activation
  becomes `unit.activated_at` beside it. This is the defect D-16 names, at the device grain: a
  soundbox the CWD activated before the courier's file arrived could never afterwards record its
  delivery, because ACTIVATED outranked DELIVERED and the monotonic guard correctly refuses to
  move backwards. Keeps the FIRST reported instant on a repeat; refuses a device already written
  off, the one place the two axes talk. Migration `20260813110000`, whose backfill carries ONE
  stated assumption (the only wired door to activation was the ops edge, which required a
  delivery date), and whose worst case costs a rung of delivery history and never the activation.
- T4.3 (L) DONE, commit `2a50551`: ACTIVATED leaves `pipeline_state`, which now carries the
  fulfillment axis only. NARROWER than this plan feared: the tiles already read
  `activation_status` directly, so only batch-journey stage 8 and the awaiting worklist were
  reading activation off the rollup. Stage 8 is now parallel to stage 7 and counted off the
  activation axis, through one shared predicate so the two halves of that question cannot drift.
  The workflow rail follows, marking Activation done while Delivery waits rather than preferring
  an axis. Migration `20260813120000` moves projected rows; a rebuild reaches the same answer
  without it. Caught a fixture that had been lying: batch-journey seeded `activation_status` as
  'ACTIVE', a value no writer emits, and got away with it while stage 8 read the rollup instead.
- T4.2 (M) DONE, commit `af10f1c`: the delivered-gate is gone from the edge, the worklist and the
  UI. ONE gate remains and it is about the thing rather than its schedule (paper does not
  activate); an unprojected row is still refused, because that gate cannot be evaluated without
  a row. The worklist's date window moved from delivery to delivery-or-receipt, since
  `withinReportWindow` rejects a null and a windowed report would have dropped exactly the rows
  this change surfaces. Also took down the ACTIVATION-EMPTY fence on the two activation tiles
  (T4.6's stale comments turned out to be suppressed BEHAVIOUR), which exposed a smoke fixture
  sending null for tiles typed as numbers; `tileCount` now degrades one bad field rather than
  the page.
- T4.5 (L) DONE, commit `5850224`: `GET /ops/reports/dispatch/:asgnId` plus the per-dispatch
  page. Composed at the EDGE from three contexts (state from analytics, delivery trail from
  fulfillment, activation trail from TMS), never joined. Needed a new ops-side shipment-trail
  read, because the existing one enters the program-scoped role and an ops operator holds no
  program scope. The branches are deliberately NOT merged into one timeline: interleaving by
  timestamp would render an early activation as a lifecycle that went backwards. A COLLATERAL
  dispatch gets no activation branch at all rather than an empty one.
- T4.6 (S) DONE as part of the above: the stale "no activation write path" / ACTIVATION-EMPTY
  comments are gone from `mediation.ts`, `TilesPage.tsx` and the tests that quoted them. NOT
  done: superseding the linear-lifecycle wording in `docs/`, which is gitignored here and
  belongs with the corpus submission (section 7).

### Phase 5: Courier and activation ingestion - 13 August 2026, one task BLOCKED

- T5.1 (M) DONE, commit `882842b`: the ops-side courier status upload. D-17's
  Phase-1 story is a spreadsheet arriving by email, and the existing batch path is JSON on a
  vendor-credentialed route, which no inbox can authenticate. So this is a SECOND SANCTIONED
  DOOR built the way TA.4 recorded the vendor intake door: the authorization differs and
  nothing else does. The row loop is now literally shared code, so the same status vocabulary,
  per-row courier-ownership rule, quarantine reasons and advance apply whichever door an update
  came through. The courier is named by the operator (a validated data attribute, not a
  principal scope, exactly like manufacturerVndrId) and naming the wrong one holds every row
  rather than moving somebody else's parcels. All three columns are required; a day/month date
  is REFUSED rather than guessed at. The csv/xlsx grid reader moved to its own fulfillment-local
  module rather than becoming its second verbatim copy.
- T5.2 (S) DONE, no code: Q19 answered by taking the recommendation, and the ruling is now
  recorded on the route itself rather than only here. The webhook receiver STAYS LIVE: it is
  additive, and it is credential-gated twice over (the class-6 guard authenticates, then a D2
  authorize checks the caller against its own vendor before any write, with an audited DENY).
  There is no unauthenticated surface to defer, and gating it off would remove a working channel
  from couriers already using it.
- **T5.3 (S) BLOCKED, and NOT built. This is an escalation, not a deferral.** D-19 asks for SIM
  No on the activation report. The ICCID is captured at intake and sits in `unit.sim_no`, so the
  data exists, but it is *deliberately unreadable*: migration 20260803120000 records that it is
  never emitted on a fact (S7) and granted to NO read role, and 20260810020000 excludes it from
  the ops grant by name, citing an OPEN architecture question about the permission surface. That
  exclusion is verified live, not just documented: a SELECT naming `sim_no` under
  `fulfillment_ops_read` fails, and there is now a test pinning it. Projecting the ICCID into
  analytics and onto a downloadable CSV would cross a security invariant and pre-empt a ruling
  the corpus has not made. Per this repo's own rule, that stops here rather than being
  improvised. See Q25. The rest of D-19 is delivered, so nothing else waits on it.
- T5.4 (M) DONE, commit `5e16ade`: bulk mark-activated, which REVERSES A RECORDED REFUSAL and
  had to answer it rather than overrule it. The refusal said a Mark-all "could only be a
  CLIENT-SIDE LOOP. A loop that fails halfway leaves the operator unable to tell which records
  went through." So this is the server-side write that refusal said did not exist: each row its
  own transaction, own gates, own 6e, and a RESULT PER ROW. The confirmation counts what
  happened, never what was asked ("1 of 2 marked activated"). The per-batch Activation stage
  stays single-record and says why; the bulk control lives on the cross-batch worklist, which is
  where a morning's confirmations are actually worked.
- T5.5 (M) DONE, commit `7a7937b`: the CWD's activation file. It names DEVICES, because that is
  what the CWD activates and it holds no dispatch id of ours, so the edge resolves each serial
  through `unit.asgn_id` and runs the same per-row activation as T5.4 (one shared function: the
  two differ only in where their list of ids came from). EVERY ROW COMES BACK, including the
  three non-error ways a row can fail to activate, because the CWD reported an activation for
  that line and losing it silently is how a device ends up with no recorded outcome. The status
  column is ENFORCED: only a success can be recorded, so a row claiming a failure is rejected by
  name rather than skipped, and success is spelled generously because the file is written by
  another company's ops team.

One gate note, and this one was a REAL defect rather than contention: `package.test.ts`
deadlocked (Postgres 40P01) against T5.1's new suite. The new suite's truncate list had been
copied wider than the suite writes, and a TRUNCATE takes an AccessExclusiveLock, so the extra
table names widened the lock set it contended on. Narrowed to what it actually writes. A
truncate list is a lock declaration, not a tidiness list, and the other wide lists in this repo
are worth the same look.

Also fixed before this phase, commit `2751d0f`: T4.4 had broken the ops device inventory
outright. The grant on `unit` is column-scoped and does not extend to columns added later, so
selecting the new `activated_at` failed with "permission denied for table unit" and took down
the whole screen. It reached the gate because NOTHING exercised `listDeviceInventory` against
the real role: the portal suite mocks fetch, and the only check on that grant was the migration
file agreeing with itself. The missing test landed with the fix.

### Phase 6: Damage reconciliation - 13 August 2026, two gaps recorded

- T6.1 (M) DONE, commit `a0f65c1`: the O-1 seam, built FIRST and deliberately
  behaviour-neutral. The decision moved out of the damage ingest into one function whose
  strategy in force is a FAITHFUL COPY of the inline code, so O-1's answer will arrive as its
  own diff against a provably identical baseline (every pre-existing damage test passed
  unchanged). The interface carries the reason and the remarks, unused today, because
  reason-implies-group is a live candidate, and it can return "I cannot decide", which is what
  makes an ops-side picker implementable. FINDING, recorded rather than smoothed over: the third
  candidate, ACCEPT OVER REPLACEMENT, does NOT fit this interface. A case is the replacement
  (case_status lives on the replacement row), so a case with no replacement has nowhere to
  exist. Two of the three candidates cost one function; that one costs a table. Whoever answers
  O-1 needs to know that before choosing.
- T6.2 (S) DONE, commit `7d66e39`: the quantity columns and the delivery-status seed are gone,
  and the two removals are different in kind. `items` leaves the CANONICAL MAPPING but survives
  on the row shape, because a profile that genuinely carries quantities must resolve as it
  always did and a future O-1 answer may want that input. `deliveryStatus` leaves the row shape
  OUTRIGHT and a case always opens at Open, because which items are damaged is something a bank
  can know and where a replacement has got to is only ours to watch.
- T6.3 (M) PARTLY DONE, same commit. D-21's explicit part is delivered and pinned: standee
  damage for a merchant who never ordered a soundbox now passes, and T6.2 is what made it pass.
  The anchor check that remains is NOT that validation; it is a structural guard on the mint,
  and it is what stops a future O-1 strategy from dereferencing an anchor that is not there.
  STILL BLOCKED on Q16: whether "VPA exists" means any assignment carries it or the merchant
  projection knows it, and whether the bank-code predicate is dropped. Not guessed: VPA is not
  unique across banks in this schema, so dropping that predicate would silently match another
  bank's merchant.
- T6.4 (S) DONE, commit `1ad7418`: `others` seeded by MIGRATION (damage_reason is preserved
  master data, so a data patch would survive locally and vanish in a fresh environment), plus
  `ops_remarks` beside `bank_remarks`. The pair is the point: a case reasoned "others" with no
  note is a case nobody can work. Omitting the note on a transition leaves an existing one
  alone. NOT done: the merchant-name column, which is Q17.
- T6.5 (M) PARTLY DONE, same commit. In Progress follows the replacement entering the pipeline;
  Closed follows a soundbox replacement being activated. Forward-only with the guard in the
  WHERE clause, because facts arrive at least once and a redelivered dispatch WILL land after an
  operator has closed a case. TMS now consumes `fct.fulfillment.dispatch.v1`, its first
  subscription to another context's fact, which is the sanctioned integration (T7) and not a
  cross-context read. TWO GAPS, both recorded: the COLLATERAL terminal is not automated (Q26),
  and no case-transition fact is emitted, so analytics still cannot unfreeze `replacementStatus`
  (a new topic is a corpus decision, same as T4.1a's; section 7 item 7).
- T6.6 (M) DONE, commit `84f3d7f`: the damage-case screen. The read had existed at the edge
  since FR08-2 with no portal surface at all, which is most of why those statuses were stale:
  nobody could see them. Both sets of remarks shown and labelled; closed cases hidden by asking
  the SERVER rather than filtering a partial list; both dispatches linked to their T4.5 detail
  pages, because a replacement and its original are separate journeys.

### Phase 7: Package and QR nuances (D-11, D-12) -  DONE 13 Aug 2026

Opened and closed 13 Aug 2026. Both gating questions were answered on the day (Q10: sanction
GRID_3X2 as an explicit D-11 exception; Q11: four files per dispatch, in two pairs, image halves
bundled). T7.1 and T7.2 landed on those answers, T7.3 is closed as will-not-do, and one guard
landed first to record a premise this plan had wrong.

The pattern in both built tasks: the DECISIONS were already satisfied and the SURFACES were not.
Grid mode already treated the Excel counts as reconciliation, but only in a source comment, and
the vendor reads a spreadsheet. The platform already produced four files, but the vendor portal
only offered two of them. Both gaps sat between a correct back end and the person holding the
paper, which is where checking a ruling against the doors rather than the service finds things.

- T7.1 (M) DONE, commit `237b9a4`, after Q10 was ANSWERED 13 Aug 2026: sanction GRID_3X2 as an
  explicit D-11 exception for presses that cannot impose. Sanctioning it exposed what made the
  conflict dangerous rather than merely untidy: a grid batch shipped pre-imposed cells AND a
  bare `Standee Count` column, so the copy count was asserted twice by two surfaces that
  disagreed about who owned it. `impose.ts` did record that the counts are reconciliation in grid
  mode, but it recorded it in a SOURCE COMMENT, and the vendor reads a spreadsheet. So the two
  count headers now say it on the sheet, and only on a grid batch. Safe against the W-5 return
  round trip by construction (the return adapter reads four columns by name and ignores the
  rest), and the round trip is now pinned on a grid-worded sheet rather than assumed.
  TWO SEAMS, both against the same class of drift: `readBatchPrintLayout` is ONE resolver for
  the merged PDF and the Excel, so a batch cannot be grid for the paper and one-per-page for the
  sheet; `buildDispatchGroupXlsx` is ONE builder for both doors, so no per-door layout argument
  is left to forget. It also falls back to ONE_PER_PAGE on an unrecognized `print_layout` rather
  than trusting a column that has no CHECK constraint, which is the safe side: claiming copies
  are already imposed when they are not gives a SHORT run, and a short run is the failure a
  merchant feels.
- T7.2 (S) DONE, commit `65a86b7`, after Q11 was ANSWERED 13 Aug 2026: four files per dispatch,
  in two pairs, and each pair's image half is one bundle carrying a page per merchant. That is
  the shape the platform already produced, so nothing about the package changed. What did not
  exist was the VENDOR'S WAY TO IT: this portal offered two buttons, the two Excels, and its own
  labels said "Soundbox Excel" and "Collateral Excel", so the gap was named and left. The images
  route has been live at the edge since spec 14b with the same own-batch authorize and the same
  ALLOW/DENY 6e as the Excel pull, and nothing in the portal ever called it, so a print vendor
  could click their way to half their package and had to hand-build a URL for the other half.
  Found by checking the ruled shape against BOTH doors rather than against the service: the ops
  portal had all four all along.
  Two things fixed on the way. `kind` joins `group` as a REQUIRED prop, on the reasoning this
  component had already recorded for `group`, since one component now covers both halves of both
  pairs and a default lets a caller quietly ask for the wrong half. And a 404 stops being a
  failure: the images route 404s when a batch has nothing in that group, which a soundbox-only
  batch legitimately does, and that fell into the generic branch whose copy is "Please try
  again", advice that could never work.
- T7.3 CLOSED AS WILL-NOT-DO, since Q10 kept grid. Its premise was WITHDRAWN (13 Aug 2026). This plan sized it S and
  called it render cost only, on the grounds that ONE_PER_PAGE delivery collapses a
  both-products merchant onto one page so the sticker artifact is never delivered. That premise
  is false twice over, both verified against the running code, not read off the source:
  (1) GRID_3X2 DELIVERS IT. A grid batch runs standee and sticker as two separate material
  runs, because a sheet never mixes standee board with sticker adhesive, and each run takes its
  copies from that line's OWN count (`assembleGridGroupPdf`). Dropping the STICKER_IMG
  composition would silently SHORTEN a real print run, not save a render.
  (2) THE EXCEL SHIPS THE REFERENCE IN BOTH LAYOUTS. The Artifact Refs cell is every
  non-superseded artifact on the line, filtered by neither layout nor delivery group, so the
  sticker reference reaches the print vendor on the sheet even under ONE_PER_PAGE.
  There is no safe half-measure either: composition is deliberately layout-BLIND (stored
  artifacts are 1-up, and flipping a vendor's layout changes the very next download with no
  re-render and no backfill, `package.ts` W-6). Making composition read the layout would trade
  a render cost for that property, which is a worse deal than the one being bought.
- T7.3-guard (S) DONE, commit `ebc923c`: the missing `artifactTypesFor` case. It had cases for
  standee-only, for the zero-count orphan and for a legacy combined row, but none for the split
  COLLATERAL row carrying BOTH counts, which is the exact row that cleanup would have changed.
  No behavior change; this is the coupling made visible, so the cleanup cannot be taken without
  first ruling on whether GRID_3X2 survives.

---

## 5. Blocked items and the seams that isolate them

**O-1 (which collateral is damaged).** THE SEAM IS BUILT (T6.1, commit `a0f65c1`); the final
strategy is still blocked. Building it revealed one thing this section had wrong: of the three
candidates named on the call, only two fit the interface. Accept-over-replacement needs a case
with no replacement, and a case IS the replacement here, so that candidate costs a table rather
than a function. Everything below still holds for the other two. Blocked tasks: T6.1's final
strategy, and T6.2 was sequenced strictly after the seam existed. Proposed seam: the `DamagedCollateralResolution`
strategy above, a single pure decision point between damage-row matching and replacement
minting in `services/tms/src/damage.ts` (today the logic is inline at `:138-167`). Every
candidate resolution named in the walkthrough call (reason-implies-group, ops-side picker,
accept-over-replacement) is expressible as an implementation of that one interface. The damage
quarantine already gives the fallback posture: when the strategy cannot decide, quarantine the
row rather than guess.

**O-2 (composite merchant identity, Phase 2).** No task in this plan is blocked by it, by
design. The guarded seam: merchant identity is resolved only via the identity projection keyed
by `bank_merchant_reference`, whose derivation lives in exactly one function
(`bank-source-profile.ts:80`). Constraint on every task above: no new code treats VPA as
merchant identity or joins on it; duplicate detection (D-5) stays an ingest gate, not an
identity rule. When O-2 lands, the derivation function changes in one place and an
additional-soundbox flag becomes readable from the same projection.

**O-3 (queue expiry, Phase 3).** Nothing to isolate; no queue code in this plan writes or
reads any age or due-date field, so the future addition is purely additive.

---

## 6. Test impact

Reality: there is no Playwright harness and no TC-AREA-NN scheme anywhere in this repo (Q2).
The real suite is vitest (about 280 files). Impact below is by area against the decisions that
invalidate current pinned behavior. Tests are not being rewritten yet, per the walkthrough.

**Invalidated by D-13 / D-15 (the one-AWB model), mostly Phase 1:**
- `services/fulfillment/test/return-sheet.test.ts` is the direct blocker: it contains a
  describe block literally named "one dispatch id, two AWBs" pinning the M3 behavior D-13
  voids, plus the collateral-link tests.
- `return-group-pairing.test.ts`, `return-sheet-adapter.test.ts`,
  `return-template-roundtrip.test.ts` (template carries the two-AWB rule).
- `apps/vendor-edge/test/` sheet-parse, http-roundtrip, return-class7-isolation, vendor-reads;
  `apps/vendor-portal/test/features/returns,history`.
- New cases implied: second-device-for-paired-dispatch quarantines with detail; collateral
  dispatch takes exactly one AWB; JSON path per-row rejection; per-courier AWB format
  accept/reject; return-row cure and Close.

**Invalidated by D-16 (branched lifecycle), Phase 4 - ALL RE-PINNED 13 Aug 2026:**
- `services/fulfillment/test/unit-lifecycle.test.ts` (linear ladder and rank-based canAdvance),
  `dispatch.test.ts` (monotonic chain pins), `ops-status.test.ts` (terminal semantics),
  `courier-status.test.ts` (delivery terminals; largely survives, delivery branch is kept).
- `apps/ops-edge/test/mark-activated-http.test.ts` pins the delivered-gate 409 that D-16
  removes (the COLLATERAL 409 pin survives).
- `apps/ops-portal/test/features/workflow-stage, workflow-stages, workflow-rail, workflow-page`
  (linear 8-stage assumptions; stages 7 and 8 become parallel), `activation.test.tsx`,
  `exception-surface.test.tsx`, `queues*.tsx`.
- `services/analytics/test/project.test.ts` (single pipeline_state fold), `batch-journey.test.ts`
  (also carries the RTO fixture bug), `group-tiles.test.ts`, `reports.test.ts`.
- Root parity guards: `test/courier_status_parity.test.ts`, `reject_reason_parity.test.ts`,
  `analytics_rail.test.ts` (status vocabulary changes must land in all mirrors or these fail,
  which is what they are for).
- New cases implied: activation before delivery is recordable and both branch terminals persist
  independently; REQUEST_SENT_TO_CWD set by report generation; activation trail append-only;
  per-dispatch detail renders both branches; standee-only rows terminal at Delivered.

WHAT ACTUALLY MOVED, against that prediction. The list above over-estimated the blast radius:
`dispatch.test.ts`, `ops-status.test.ts`, `courier-status.test.ts`, the workflow rail suites,
`exception-surface.test.tsx`, `queues*.tsx`, `group-tiles.test.ts` and all three root parity
guards passed UNCHANGED, because the delivery branch was already correct and D-16 only stopped
activation from standing on it. What did move: `unit-lifecycle.test.ts` (re-pinned to the branch
shape, plus the defect case on the fact rail), `mark-activated-http.test.ts` (the delivered-gate
409 became a 200), `activation.test.tsx` (the disabled control became enabled),
`project.test.ts`, `batch-journey.test.ts`, `batch-journey-route.test.ts`, `reports.test.ts`,
`reports-routes.test.ts`, `inventory.test.tsx`, `dashboards.test.tsx`, `portal-smoke.test.tsx`
and `workflow-stages.test.tsx`. New suites: `services/tms/test/activation-branch.test.ts` and
`apps/ops-portal/test/features/dispatch-detail.test.tsx`.

Three fixtures were found to have DRIFTED FROM THE WIRE CONTRACT under cover of code that never
read them: batch-journey seeded `activation_status` as 'ACTIVE' (no writer emits it), the
dashboard smoke test sent `null` for tiles typed as numbers, and the mark-activated edge test
minted a claim whose `sub` was a readable label rather than a uuid. All three were invisible
until the value was actually used. Same class as the RTO defect: worth a sweep of the remaining
fixtures that stand in for a writer, rather than waiting for the next feature to trip over one.

**Invalidated or re-baselined by D-7 ripple (mostly already re-pinned by the W-5 branch; listed
for completeness):** `services/tms/test/per-group-*.test.ts`, `assignment.test.ts`,
`ingest.test.ts`; `services/fulfillment/test/pool-dispatch-group.test.ts`,
`package-group-membership.test.ts`, `lot-size-requests.test.ts` (request-grain counting);
`apps/ops-portal/test/lib/dispatchGroups.test.ts`.

**Workflow A (Phase A):** `services/fulfillment/test/device-inventory-format.test.ts` and
`device-inventory-brd-shape.test.ts` pin the strict validation TA.1 removes; intake ICCID-dup
tests for TA.2.

**Damage (Phase 6):** `services/tms/test/damage.test.ts` (FR08-1 quantity pin, deliveryStatus
seed pin), `per-group-damage.test.ts` (items-driven discrimination becomes strategy-driven),
`damage-reason.test.ts` (seed set), `ops.test.ts` case-status block (transition graph),
analytics reports/tiles for the unfrozen replacementStatus.

**Batching (Phase 3):** `batching-timer.test.ts` (max-wait re-anchor plus the disarm-recovery
case) and `batching-ops.test.ts` (hold reason) are DONE, both extended rather than rewritten;
`apps/scheduler/test/tick.test.ts` also moved, because it sweeps with a FUTURE clock and the
re-anchor made that clock choice load-bearing. `batching-config.test.ts` (program-tier
rejection) still waits on Q12.

One thing the Phase 3 gate taught, worth recording for later phases: `pnpm typecheck` does not
cover test files, so a signature change that breaks a fixture (holdRecord's now-required
reason) surfaces only at `pnpm test`. Budget for that on every task that tightens a signature.

---

## 7. Owed to the architecture corpus (per this repo's governance)

The walkthrough's D-numbers are a product ledger, not corpus decisions. Items that reverse or
extend corpus-recorded rulings must ride the next corpus submission (pattern:
`docs/plan/CORPUS_SUBMISSION_2026-08-10.md`):

1. D-13 as a reversal of M3 (the collateral second-AWB mechanism, its cap, and the additive
   shipment-fact fields; the fields stay wire-compatible but stop being written).
2. D-20 as a reversal of FR08-1 (damage quantity columns).
3. Workflow A validation as a reversal of the 2026-08-09 locked inventory rule.
4. The D-16 activation-branch state: new enum tokens, the activation status-event table, and
   the analytics two-axis fold (touches the fact vocabulary mirrors).
5. TA.3 Soundbox ID: any new identifier is a corpus I4 decision by definition.
6. D-19 bulk mark as a reversal of the recorded "no mark-all, deliberately" ruling. LANDED
   13 Aug 2026 (T5.4). The refusal was answered rather than overruled (a server-side write with
   a per-row result), and the original reasoning is preserved in both files; the submission
   should carry that, not just the reversal.
7. The D-24 case-transition fact (new fact or additive field: needs the corpus's additive rule).
   STILL OWED after T6.5: the transitions now happen, but nothing is published, so analytics
   cannot unfreeze `replacementStatus`. Same shape as item 8 below and blocked for the same
   reason: a new topic is a corpus decision and needs provisioning applied out of band (S23).
8. The activation-request fact, if analytics is ever to report REQUEST_SENT_TO_CWD (T4.1a built
   the state without one, since a new topic is a corpus decision and needs provisioning applied
   out of band, S23). Not needed for anything shipped: the ops surfaces read it from TMS.
9. The ICCID permission surface (T5.3 / Q25). Not a reversal, an UNANSWERED question the code
   has been deferring to since 20260803120000 and which D-19 has now walked into.
10. The D-11 CARVE-OUT for GRID_3X2 (T7.1 / Q10, ruled 13 Aug 2026). The exception is recorded in
    this repo, at the conflict itself (`impose.ts`) and on the sheet the vendor reads
    (`package.ts` COUNT_HEADERS), but a decision that a mode may answer a numbered decision
    differently belongs in the corpus, not in a source comment. This is the one item on this list
    that is fully BUILT and only needs writing down: nothing is blocked on it.

---

## 8. Questions (answer before the tasks they gate; none are guessed in this plan)

1. **Stack:** the walkthrough locks MySQL and Redis; the repo is Postgres and Kafka throughout.
   Assume the walkthrough line is stale boilerplate and Postgres stays?
2. **Playwright TC-IDs:** the walkthrough references a Playwright harness with TC-AREA-NN IDs.
   None exists in this repo. Is that harness external (QA-owned), or is building one in scope?
3. **Workflow A headers:** ANSWERED by taking the recommendation (12 Aug 2026, TA.1). A file
   missing the Device ID column is still a one-error structural reject; Sim No and Device QR
   are optional columns that never reject a row or a file.
4. **Soundbox ID shape:** ANSWERED 12 Aug 2026 (TA.3). The existing `unit_` wire id IS the
   system-generated Soundbox ID; no new id kind was minted, so no corpus I4 decision is owed.
   It is surfaced on the ops inventory screen. Still open, and deliberately not assumed: whether
   it should also appear on vendor, return-sheet or report surfaces, which would be a wire
   contract change.
5. **Vendor intake door:** ANSWERED 12 Aug 2026 (TA.4). `POST /vendor/intake` is kept as a
   second sanctioned channel, with its stricter class-6 validation intact and the asymmetry
   recorded in code.
6. **Held-row retention:** curing without re-keying requires persisting the quarantined row's
   content, which the current code deliberately redacts (PII posture). Persist the full
   structured row, or only the cure-relevant fields (VPA, soundbox flag, merchant display)?
7. **Queue action set:** the queue also holds format rejects. Are Close and the two legal edits
   scoped to duplicate-reason rows only, with format rows keeping the free-form cure
   (recommended), or do all rows get the two-action treatment?
8. **QR artifact format:** pages are vector PDFs today, never PNG/JPG image files. Does any
   walkthrough use of "image" require raster files, or is PDF fine (recommended: PDF)?
9. **Bank Master and logo:** the logo lives on the composition config keyed (bank, branch); the
   identity Bank Master has no logo field. Is the current split acceptable as "logo from Bank
   Master"?
10. **GRID_3X2 vs D-11:** grid mode bakes the N copies into the print run, contradicting
    "vendor prints it N times". Retire grid, sanction it as an exception, or leave it
    per-vendor selectable? SHARPENED 13 Aug 2026 (T7.3 guard), with two things this plan did
    not know when it wrote the question. First, the codebase has already recorded a reading of
    the conflict rather than left it open: `impose.ts` states that in grid mode the PDF IS the
    exact print run and the Excel's count columns are RECONCILIATION, not instruction. So the
    two surfaces do not contradict each other today; what they do is answer D-11 differently
    depending on the bound vendor's press. Second, the blast radius is larger than "one layout
    branch": retiring grid also unblocks T7.3, and KEEPING grid blocks T7.3 permanently, because
    the second collateral artifact is delivered as its own material run.
    ANSWERED 13 Aug 2026: SANCTION GRID AS AN EXPLICIT EXCEPTION for presses that cannot impose,
    since it exists because the printer cannot do it, which is a capability fact rather than a
    preference. Built as T7.1, commit `237b9a4`, which also closes the double copy-count
    instruction the sanction exposed: the sheet now says which surface owns the count, because
    `impose.ts` saying so in a comment was never going to reach the person reading the
    spreadsheet. T7.3 is closed as will-not-do in consequence. The carve-out is owed to the
    corpus (section 7).
11. **"Separate image files":** the package ships two merged PDFs (one page per merchant per
    group), not per-merchant files. Is merged-per-group acceptable (recommended), or are
    per-merchant files or a zip required? ANSWERED 13 Aug 2026: four files per dispatch,
    in two pairs, a soundbox Excel plus soundbox QR images and a sticker-plus-standee Excel plus
    its QR images. That is exactly the shape that ships today (two group-keyed Excels plus two
    merged PDFs), so on the batch-level reading T7.2 is already built and D-12's "separate image
    files" means separate PER GROUP.
    The GRAIN was asked separately rather than assumed, because "per merchant" in the answer could
    carry either reading and they are a small edit apart from a large one, and it resolved to the
    bundle: each pair's image half is ONE file carrying a page per merchant, so four files per
    dispatch full stop, not four per merchant (which on the print vendor's real 340-merchant batch
    would have been roughly 1,360 files, a zip, a new route, a naming rule, and an answer for grid
    vendors whose print unit is the sheet). Built as T7.2, commit `65a86b7`: the shape needed no
    change, the vendor's access to it did.
12. **Batching program tier:** the per-(tenant, program) override tier exists but D-10 grants
    no overrides. Remove the write, or record the tier as an approved forward hook?
13. **Max-wait anchor:** BUILT TO THE LITERAL WORDING 13 Aug 2026 (T3.3). "Oldest record at
    least Max Wait Time" is now read as per-oldest-entry age, not time-since-last-batch. This
    was implemented rather than left waiting because the document wins where it and the code
    conflict, and its wording admits only one reading. Flagged, not closed: if the intent really
    was time-since-last-batch, T3.3 is the change to revert, and it reverts cleanly (one guard
    in `runDueBatchTimers` plus the `delaySeconds` argument).
14. **D-18 exceptions:** FAILED is deliberately non-terminal (can move forward to DELIVERED),
    and a step-up-gated audited `overrideTerminal` exists for corrections. Keep both as
    sanctioned exceptions to the dead-end rule (recommended), or make FAILED terminal and
    remove the override?
15. **D-13 legacy scope:** do pre-split (null dispatch group) rows keep their documented
    two-AWB allowance (grandfathered, recommended), or is the rule retroactive (requires
    gating off the collateral-link mechanism for legacy reads too)?
16. **D-21 precise meaning:** does "VPA exists in our system" mean any assignment row carries
    the VPA (current reachable meaning) or the merchant projection knows it; and is the
    bank-code predicate dropped even though VPA alone is not unique across banks?
17. **Damage file fields:** the decision lists merchant name (not currently mapped) and does
    not list ship-to (currently required and authoritative for the replacement address). Is
    merchant name informational-only, and where does the replacement's ship-to come from if
    the field list is exhaustive (clone the original's)?
18. **D-23 QR payload:** replacement regenerates the artifact but clones the QR payload (same
    VPA). Confirm "QR regeneration is unconditional" means the artifact, not a new payload.
19. **Webhook receiver:** the courier status webhook is already built and routed, though the
    walkthrough files webhooks under Phase 2. Keep it live (recommended, it is additive and
    credential-gated), or gate it off until Phase 2?
20. **D-24 close predicate:** SUPERSEDED BY Q26 (13 Aug 2026, T6.5). For SOUNDBOX the answer
    taken is the activation terminal, per this plan's own reading of D-16, and it is built that
    way. What is left open is the COLLATERAL half, which turned out to be an architecture
    question rather than a product one; see Q26.
21. **Return dispatch date:** the walkthrough lists dispatch date as a return-file field; the
    code deliberately uses the server clock. Vendor-reported column, or server clock stays?
22. **AWB format source:** per-courier AWB validation needs the pattern master. Who supplies
    the formats (courier master data entry by admin?), and is an unknown courier still a
    non-rejecting exception?
23. **D-5, must the ORIGINAL itself have a soundbox?** (Raised 12 Aug 2026 while building T2.3a,
    and NOT resolved unilaterally.) D-5 says the gate fires when "VPA already exists in the
    system AND the incoming row has Soundbox = Yes", and that is literally what the code does:
    the collision scan matches any earlier record carrying that VPA, whether or not it included
    a soundbox. So a soundbox row whose VPA appears only on an earlier STANDEE-ONLY request is
    held. Under D-6 ("one soundbox per VPA") that merchant has no soundbox yet, so arguably
    nothing is being protected and the hold is spurious. Narrowing the scan to
    soundbox-bearing originals would match D-6's intent but contradict D-5's wording, which is
    why it was left alone. Which reading governs?

24. **The CWD-request trigger (D-16, raised by T4.1b):** D-16 says report generation sets
    REQUEST_SENT_TO_CWD, and the literal reading puts a write inside
    `GET /ops/reports/activation`. That route is a pinned pure read whose posture is that reads
    are not mutations, and a mutating GET is retried by proxies and prefetched by browsers. Built
    instead as an explicit operator action, `POST /ops/assignments/request-activation`, which is
    also the claim the audit record should carry. Confirm that reading, or rule that downloading
    the report is itself the send. The domain write is the same function either way, so moving
    the trigger costs a route and no state.

25. **SIM No on the activation report (D-19, raised by T5.3, ESCALATED 13 Aug 2026):** D-19 asks
    for the ICCID on the activation report. The data is captured at intake and sits in
    `unit.sim_no`, but it is deliberately unreadable: migration 20260803120000 records that it is
    never emitted on a fact (S7) and granted to NO read role, and 20260810020000 excludes it from
    the ops grant by name, citing an OPEN architecture question about the permission surface.
    Verified live, not just documented: a SELECT naming it under `fulfillment_ops_read` fails,
    and a test now pins that. Projecting it into analytics and onto a downloadable CSV would
    cross a security invariant and pre-empt a ruling the corpus has not made, so it was NOT
    built. This is the one place in this plan where the document and the code conflict and the
    document does not simply win: elsewhere a conflict is a product decision, and this one is a
    PII/residency ruling that belongs to the architecture corpus. Needed: does the activation
    report carry the ICCID, and if so under what grant, to which roles, and with what treatment
    on the CSV export? Until then the report carries Device IDs, which it already does.

26. **The COLLATERAL close predicate (D-24, raised by T6.5, 13 Aug 2026):** a soundbox
    replacement closes when it is activated, which TMS observes directly. A COLLATERAL
    replacement's terminal is DELIVERY, which only fulfillment sees, and the shipment fact
    carries a shipment id rather than an assignment id. Closing on it would need TMS to hold a
    shipment reference so it could map one to the other, and this schema's own header says TMS
    carries no fulfillment status columns (T2, T12). Three ways out, none of them mine to pick:
    let TMS hold the reference (weakens T2/T12), have fulfillment carry the assignment ids on
    the shipment fact (a fact-shape change, corpus-owed), or drive the close from analytics,
    which already holds both axes but is a read model that writes back to nothing (T2/T12 again).
    Until then a collateral case is closed by hand, which works and is visible on the new screen.
    This also subsumes the original Q20: for SOUNDBOX the answer taken is the activation
    terminal, per this plan's own reading of D-16, and it is built that way.

---

## 9. What this plan deliberately does not do

- No code, no migrations, no test edits. Nothing in the working tree changed except this file.
- No architecture invention: every new column, status token, fact, and the Soundbox ID are
  flagged to the corpus (section 7) rather than designed here.
- Phase 2/3 walkthrough items (courier aggregator APIs, direct CWD API, composite merchant
  identity, queue expiry) are design-protected via the seams in section 5 and built by nobody.
