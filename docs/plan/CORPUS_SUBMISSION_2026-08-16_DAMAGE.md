# Corpus submission, 2026-08-16 (the damage workflow, D-24 to D-31)

No em/en dashes (repo rule).

## What this is, and what it is not

The decisions of the 13 Aug 26 product call, written up in the BRD update
"Revised Damaged and Replacement Workflow" and handed to this repo on 16 Aug
as decisions D-24 to D-31, are BUILT on branch `feature/damage-workflow`
(pushed, tip `613a956`, seven commits, full gate 286 files / 2302 tests, live
portal walkthrough recorded in `DAMAGE_PLAN.md` section 8). This document asks
the corpus to record the decisions, ratify the shapes the build chose where
the words left room, and close two items the predecessor submission carried.

**Nothing here is ratified.** Claude authored it against
`feature/damage-workflow` at `613a956`; Bhupender takes it to the architecture
chat. Where the built shape is narrower or different than the decision's
words, the difference is stated, not smoothed over.

Predecessor: `docs/plan/CORPUS_SUBMISSION_2026-08-16.md` (the walkthrough
debt, R-7, the ICCID). This document SUPERSEDES its item 2 and ANSWERS its
question 1; everything else there is still owed on top of this list.

## How to read the status column

- **VERIFIED** means built, gated, and live-verified in the 16 Aug damage
  session, with the file or commit named.
- **CARRIED** means taken from the BRD update or the handoff prompt and not
  independently evidenced here (the update itself lives outside this repo).

---

# Group A. The decisions themselves (record as ruled, none invented here)

| # | Decision | What was ruled (13 Aug call, BRD update) | What ships | Status |
| - | -------- | ---------------------------------------- | ---------- | ------ |
| 1 | **D-25, no file ingestion** | Damage intake is an in-screen action at the Dispatch ID level; old D-20 and D-21 are VOID. Complaints arrive by any channel; none is ingested. | The entire damage file path is deleted: `services/tms/src/damage.ts`, `damage-resolution.ts`, the adapter's damage half, preview and commit routes, the portal upload page and kind, the `ops:upload-damage-file` permission, and their tests (commit `f434634`, `0b88047`, `e072b32`). No staging table existed; historical file-born rows stay untouched. | VERIFIED |
| 2 | **D-26, the human resolves the target** | Ops searches by VPA, sees every Dispatch ID for the merchant with branch statuses, opens the right one, flags it. NO automatic soundbox-vs-standee resolution. Flaggable from any status. | New read `searchDispatchesByVpa` (tms, `LOWER(TRIM(vpa_value))` match on the existing functional index) behind `GET /ops/dispatches/by-vpa`; the portal search lives on the Damage cases page. Because a Dispatch ID is already one W-5 leg, the operator's choice of ID IS the group resolution, which dissolves the O-1 seam (the old `DamagedCollateralResolution` strategy is deleted with D-25). | VERIFIED |
| 3 | **D-27, the three captures** | Reason from the configurable master (must include Others); free-text remarks; items to replace with counts, soundbox FIXED at 1 per VPA (D-6), no soundbox count field. | The flag dialog captures exactly these. Reason is validated ACTIVE against the master and stored by CODE (see B-3). Remarks are required, trimmed, max 500, stored on the row (`ops_remarks`), never on a fact (S7). A COLLATERAL leg takes standee and sticker counts, integers 0 to 99, total at least 1; a SOUNDBOX leg has no count input and states the fixed-one rule on screen. `created_by` lands as the new `assignment.flagged_by` column (migration `20260816120000_flag_damage_in_screen`). | VERIFIED |
| 4 | **D-28, child Dispatch ID, standard flow** | Flagging creates a child Dispatch ID, bidirectionally linked, Non-Billable, carrying the counts, entering the NORMAL pipeline with no special-casing beyond the flag and the link. | `flagDamageOps` mints the child through the SAME mint the file path used: `billable=false`, `replacement_of` (the link; the read side projects both directions), counts per the leg, then `replacement_raised` fact plus the standard demand fact, so the child pools, batches, composes QR unconditionally, and activates if it is a soundbox line. Live-verified end to end: a flagged child re-filled the pool, a real LOT_SIZE batch claimed it, and the dispatch fact moved its case to In Progress with zero replacement-aware code downstream. | VERIFIED |
| 5 | **D-29, the Customer Support role** | New restricted role: search and view dispatch and request statuses, Flag Damage. NO upload or download permissions, no config access, no batching controls. | `customer_support` in both role configs (`services/auth/src/config/roles.ts`, `services/fulfillment/src/ops-config.ts`), one mutation permission `ops:flag-damage`. The read side needed NEW machinery (see B-4). Live-verified: `uat.cs1` logged in, searched by VPA, flagged a dispatch, and the hash-chained 6e names the CS principal. | VERIFIED |
| 6 | **D-24, the case overlay (unchanged, confirmed)** | Open on flag, In Progress in pipeline, Closed at the child's terminal (Delivered for standee lines, Activated for soundbox lines). Driven by existing status events; the dispatch state machine is not forked. | The overlay stays where this repo already had it, ON the replacement assignment (`case_status`, forward-only), and the missing terminal is now automated: TMS consumes `fct.fulfillment.shipment.v1` and closes a COLLATERAL replacement case on DELIVERED (see C-1, which answers the predecessor's question 1). Activation close already existed. | VERIFIED |
| 7 | **D-31, dashboard visibility** | Case status visible on the dashboard: tenant-scoped counts by status, a tile, drill-down to the filtered case list. Dispatch progress stays on the child; never duplicated onto the case. | `countDamageCasesByStatus` (tms) behind `GET /ops/damage-cases/summary`; the Command Center tile shows the three live counts, each deep-linking `/damage-cases?status=`. Deliberately a TMS read, NOT analytics, because `case_status` is still never projected (the predecessor's item 8 posture holds; see D-2). | VERIFIED |
| 8 | **D-30** | Not present in the handoff (the numbering runs D-25 to D-29 plus D-24 and D-31). | Nothing built against it. Recorded so the gap in the numbering is deliberate on both sides, not a lost decision. | CARRIED |

# Group B. Shapes the build chose where the words left room (ratify these)

| # | Shape | Why, and what the alternative was | Status |
| - | ----- | --------------------------------- | ------ |
| 1 | **No `damage_cases` table.** The handoff sketched one; the repo already implements the case AS the replacement assignment (columns plus forward-only transitions plus the `replacement_raised` fact), and D-24 forbids forking the state machine. The build extended the overlay (one column, `flagged_by`) instead of duplicating its state into a parallel aggregate. | A separate table would hold copies of statuses the assignment already owns, and the two would drift. DAMAGE_PLAN DP-1. | VERIFIED |
| 2 | **The duplicate rule (delegated as decide-and-document): one live case per dispatch.** Flagging 409s while the dispatch has a child whose case is not Closed; a new flag is allowed after close (repeat damage is real). Flagging a REPLACEMENT itself is allowed under the same rule (a replacement can arrive damaged; D-26 lists "any replacements" among the flaggable). | The alternative (one case ever per dispatch) starves repeat damage; unlimited concurrent cases would raise parallel replacements for one complaint. DP-3, OQ-1. | VERIFIED (409 pinned in the edge suite; the UI withdraws the control while a case is live) |
| 3 | **Reason stored by master CODE, not label.** File rows used to store bank-sent text matched by label; the operator now picks from the master, so the code is the honest value. Old free-text rows stay as they are, both render (OQ-5: no backfill). | Storing the label would re-introduce text matching for a value the system itself supplied. DP-5. | VERIFIED |
| 4 | **The first read-side authorization machinery on the ops plane.** The corpus-recorded posture is that reads are guard-only and read permission strings are deliberately not minted. D-29's "no download, no config access" cannot be said in that vocabulary, so `apps/ops-edge/src/read-restriction.ts` carries a role-keyed DENY list (`customer_support`) applied to: the two batch binary downloads, report CSV export (denied BEFORE the read-audit emit so a refusal leaves no ALLOW row), and the bank-config and batching-config views. JSON report views and dispatch reads stay open. Additionally the three upload previews that ran NO authorize (device-inventory, unit-status, return) now gate on their own upload permissions, closing a hole any restricted role would have read sheet contents through. | The alternative was minting read permissions for every role, reversing a recorded convention for one role's sake. The deny list is the narrower change; if a second restricted role ever arrives, re-open this. DP-8, DP-9. | VERIFIED (RBAC boundary suite: CS 403 on every upload, preview, download, CSV, config view; full roles unaffected) |
| 5 | **The child's `source_event_id` is `ops-flag|<Idempotency-Key>`.** The column is a correlation string, not an id kind: file rows already write `fileId|rowNo`. No new wire-id prefix was minted (I4 untouched); the form makes replays idempotent under the existing `(source_event_id, dispatch_group)` unique. | A synthetic fileId-shaped value would forge provenance; a random value would break replay idempotency. DP-4. | VERIFIED |
| 6 | **In Progress fires at SENT_TO_VENDOR, not at batching.** D-24 says "child dispatch in pipeline"; the built transition is the narrowest existing reading (it predates this branch) and is forward-only. Widening to batched-means-in-progress is a one-line change if the chat prefers that reading. | DP-10, OQ-3. | VERIFIED as built; the reading itself is the ask |
| 7 | **`replacement_raised.bankRemarks` rides empty on a flagged child.** No bank wrote anything, and operator free text never rides a fact (S7); the wire schema requires only the two ids. | DP-14. | VERIFIED |
| 8 | **Non-Billable in reports: surfaced, never hidden.** The damaged-replacement and soundbox-delivery reports (and their CSV exports) carry a `billable` column from the fold; no row is excluded. Billing excludes what it must downstream; the report keeps telling the whole truth. | The alternative reading of "respected in exports" (dropping non-billable rows) would make the delivery report disagree with the courier's reality. OQ-4. | VERIFIED |

# Group C. Items this build closes from the predecessor submission

| # | Item | Status |
| - | ---- | ------ |
| 1 | **Question 1 (Q26, the COLLATERAL close predicate) is ANSWERED by the middle option the predecessor listed:** "fulfillment carries assignment ids on the shipment fact". No fact-shape change was needed, because the collateral shipment fact has carried `asgnIds` since D-13; what was missing was the consumer. TMS now subscribes to `fct.fulfillment.shipment.v1` (the same sanctioned T7 integration as its dispatch.v1 subscription) and closes COLLATERAL replacement cases on DELIVERED, forward-only, per-assignment program re-pin, inbox-deduped. Manual close (`ops:update-damage-case`) survives as the escape hatch. The chat should record Q26 as closed by this shape. | VERIFIED (eight-case listener suite; not live-driven to Delivered in the walkthrough) |
| 2 | **Item 2 of the predecessor (D-20 reverses FR08-1) is VOID with its subject.** D-25 deletes the damage mapping entirely, so the D-20 versus FR08-1 tension no longer exists; the operator's counts (D-27) are now the only quantity authority. Strike it rather than ratify it. | VERIFIED (the mapping is gone) |
| 3 | **Item 8 of the predecessor (the D-24 case-transition fact) STANDS, sharpened.** Case transitions are now event-driven, but still nothing PUBLISHES a case-status fact, so analytics `replacementStatus` stays frozen at RAISED and the D-31 tile deliberately reads TMS instead. The day the corpus wants case progress in analytics or tenant reports, that is the new topic (S23, out-of-band provisioning) items 8 and 9 of the predecessor already describe. Until then the under-report is by design. | VERIFIED posture |

# Group D. New surfaces and mirrors for awareness

| Item | Status |
| ---- | ------ |
| **New permission string `ops:flag-damage`; `ops:upload-damage-file` retired.** Same mirror class as G-10 and the return-upload permission in the predecessor. | VERIFIED |
| **The ICCID question (predecessor Group C) gains a ROLE dimension.** `customer_support` can open the device detail, which shows the full ICCID and raw QR payload; the built line denies CS only downloads, CSV, and config views (DP-8, OQ-2). When the chat confirms the ICCID grant, it should now also name WHICH ROLES may read it, or the CS read line moves. | VERIFIED behavior; the ruling is the predecessor's pending ask, widened |
| **UAT ledger R-6 is overtaken.** The 16 Aug UAT ruling ("damage raise-from-UI deferred; the FILE drives the lifecycle for UAT") lasted a day: the 13 Aug BRD update, delivered 16 Aug, voids the file path. `docs/plan/UAT_RUNBOOK.md` line 83 is stale until the branch merges; the runbook should be re-cut for any UAT run on this branch. | VERIFIED (the ledger says one thing, this branch does the other, deliberately) |
| **Operator provisioning for the new role is harness-only.** No operator-creation endpoint exists in any edge; `uat.cs1` is seeded by the gitignored harness like every other operator. If CS agents are real people at go-live, provisioning becomes a real surface and a new decision. | For awareness |
| **PLAN.md D-20/D-21/O-1 blocks carry a superseded banner** pointing at DAMAGE_PLAN.md; kept as history, not deleted. | VERIFIED (commit `de8b409`) |

---

# Suggested order for the architecture chat

1. **Group A wholesale** (record D-24 to D-31 as ruled; they came FROM product,
   the chat is recording, not deciding).
2. **B-4, the read-side deny machinery**, because it is a new authorization
   posture on the ops plane, and the ICCID-role widening (Group D, item 2)
   hangs off the same line.
3. **C-1**, so Q26 is closed in the corpus the same way it closed in code.
4. **B-2, B-6** (the delegated duplicate rule and the In Progress timing),
   the two places the build chose a reading the chat could reasonably move.
5. The remaining B shapes and D mirrors in one pass.
