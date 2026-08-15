# Corpus submission, 2026-08-16 (the walkthrough debt, R-7 and the ICCID)

No em/en dashes (repo rule).

## What this is, and what it is not

The twelve items owed to the architecture corpus after the 12 Aug walkthrough
build (PLAN.md section 7, items 1 to 10) plus the two added by the 16 Aug UAT
session (`docs/plan/UAT_DECISIONS_2026-08-16.md`, items 11 and 12). Each one
reverses, extends, or walks into a corpus-recorded position, so by this repo's
governance none of them is settled by the code that ships it.

**Nothing here is ratified.** Claude authored it against `main` at `b767c18`;
Bhupender takes it to the architecture chat. Where the repo and a recorded
decision disagree, the disagreement is stated, not smoothed over.

Predecessor: `docs/plan/CORPUS_SUBMISSION_2026-08-10.md` (G-1, G-8 to G-11).
Its items are NOT repeated here; anything there still unratified is still
owed on top of this list.

## How to read the status column

- **VERIFIED** means checked against the working tree in the sessions of 15
  and 16 Aug 2026, with the file or commit named.
- **CARRIED** means taken from PLAN.md's audit and not independently re-read
  this week. Treat it as a claim to confirm, not as evidence.

---

# Group A. Reversals of recorded rulings (the corpus says one thing, the code now does another)

| # | Item | What the corpus records | What ships today | Status |
| - | ---- | ----------------------- | ---------------- | ------ |
| 1 | **D-13 reverses M3** (one AWB per Dispatch ID) | M3 (10 Aug): one Dispatch ID may carry a second, collateral AWB, via the `collateral_shipment` link and additive shipment-fact fields. | The device leg caps a dispatch id at one AWB; a second unpaired serial quarantines as `dispatch_already_has_device` with the incumbent named in `intake_exception.detail` (T1.1, commit `cf882f5`). The collateral second-AWB path survives ONLY for pre-split null-group rows; retiring it for group rows (T1.2) is blocked on the Q15 legacy ruling. The additive fact fields stay wire-compatible but should be recorded as no-longer-written once T1.2 lands. | CARRIED (T1.1 behavior), with T1.2 explicitly open |
| 2 | **D-20 reverses FR08-1** (damage quantity columns) | FR08-1: the damage file's soundbox/standee/sticker quantity columns are authoritative and drive what a replacement replaces. | The default damage mapping carries NO quantities and NO delivery status; the decision runs through the `DamagedCollateralResolution` strategy seam, falling back to replace-what-the-request-shipped, with quarantine when the strategy cannot decide. | VERIFIED. `services/tms/src/bank-file-adapter.ts` `DEFAULT_DAMAGE_COLUMN_MAPPING` and its T6.2 comment block, re-read 15 Aug. |
| 3 | **Workflow A reverses the 2026-08-09 locked inventory rule** | The inventory validation block was comment-locked ("LOCKED BY BHUPENDER 2026-08-09, do not improve"): SIM No and Device QR required, format regexes enforced. | Device ID presence is the ONLY row check; SIM No and Device QR are optional pass-through columns; the lock comment is replaced by a superseded-lock note citing the walkthrough (TA.1, commit `8b28ed6`). A missing Device ID COLUMN stays a whole-file reject. | CARRIED (commit named; the file was not re-read this week) |
| 4 | **D-19 bulk mark reverses the recorded "no mark-all, deliberately"** | The refusal is on record in the old `ActivationStage.tsx` reasoning: no bulk activation control, deliberately. | Bulk mark-activated exists as a SERVER-SIDE write with a per-row result (T5.4, landed 13 Aug). The original refusal's reasoning is preserved in both files; the submission should carry that the refusal was ANSWERED (per-row accountability kept) rather than overruled. | CARRIED |
| 5 | **R-7 revises D-10** (per-bank batching tier) | D-10: batching config is (tenant, program) with tenant and global tiers; NO per-bank overrides granted. | Ruled IN by Rahul on 16 Aug (UAT_DECISIONS R-7) and BUILT the same day (commit `37413e9`, migration `20260816090000_batching_bank_tier`). Shape is deliberately NARROWER than the words: a bank-tier row carries MIN LOT ONLY; a bank with a row is evaluated on its own pooled count and its trigger claims only its own entries (BRD 5.3.3's evaluate-per-bank without re-graining the pool); max wait stays pool-tier because the timer is armed per pool, and both the write path and a table CHECK refuse a bank-tier wait ceiling. If per-bank max wait is ever wanted, that is a pool re-grain and a new decision. | VERIFIED (built and gated this session, 286 files / 2285 tests) |

# Group B. New state, facts, and identifiers the corpus has not recorded

| # | Item | Status |
| - | ---- | ------ |
| 6 | **The D-16 activation branch.** New enum tokens (`REQUEST_SENT_TO_CWD`, `ACTIVATED`), the append-only `assignment_activation_event` table, `assignment.activation_status` denormalized forward-only, and the analytics two-axis fold (activation independent of delivery; COLLATERAL terminal at DELIVERED). Touches the fact vocabulary mirrors, which is exactly what the root parity guards pin. | VERIFIED for the schema half: `services/tms/prisma/schema.prisma` `activationStatus` comment block and the `AssignmentActivationEvent` model, re-read 15 Aug. The fold itself CARRIED. |
| 7 | **TA.3, the Soundbox ID reading.** Q4 resolved to: the existing `unit_` wire id IS the system-generated Soundbox ID; no new id kind was minted, so no I4 decision was needed. The corpus should still record the READING, because the alternative (a new prefix) was live in the walkthrough, and whether the `unit_` id may appear on vendor, return-sheet, or report surfaces is a wire-contract question deliberately left open. | CARRIED |
| 8 | **The D-24 case-transition fact.** Case transitions now happen (Open / In Progress / Closed, manual, on the cases screen) but NOTHING IS PUBLISHED: no fact, no topic, so analytics `replacementStatus` stays frozen at RAISED. A new topic is a corpus decision with out-of-band provisioning (S23). Until ruled, the dashboards under-report replacement progress by design. | CARRIED |
| 9 | **The activation-request fact.** T4.1a built `REQUEST_SENT_TO_CWD` as TMS state with NO fact behind it, for the same S23 reason. Nothing shipped needs it (ops surfaces read TMS directly); it becomes real the day analytics must report the state. Rule it together with item 8; they are the same shape. | CARRIED |
| 10 | **The D-11 GRID_3X2 carve-out** (Q10, ruled 13 Aug). Grid mode bakes the N copies into the print run, answering D-11 differently per the bound vendor's press capability. Recorded in this repo at the conflict (`impose.ts`) and on the sheet the vendor reads (`package.ts` COUNT_HEADERS), but a decision that a mode may answer a numbered decision differently belongs in the corpus, not a source comment. Fully BUILT; this item only needs writing down. | CARRIED |

# Group C. The ICCID (item 12 of the UAT ledger; leads this submission)

This is the one item where a PII surface is live ahead of its corpus
confirmation, which is the same class as the 10 Aug CODEOWNERS finding: a
control question, not a feature question.

The sequence, so the chat rules on the whole of it rather than the last step:

1. Migration `20260803120000` records the ICCID as granted to NO read role,
   citing an OPEN architecture question (S7: never on a fact).
2. Migration `20260812150000_unit_sim_qr_ops_read` (the inventory-ownership
   branch) grants `sim_no` and `device_qr` to `fulfillment_ops_read` under a
   12 Aug product ruling. **Its own header says "Pending written confirmation
   in the architecture chat." That confirmation is still owed and is the ask.**
3. The same day, the recorded masked-list-with-per-device-reveal posture was
   overturned; the inventory LIST now carries the ICCID IN FULL. A wider
   exposure than what was first ruled; it should be confirmed deliberately,
   not inherited.
4. 16 Aug (R-5, approved by Rahul as product): the activation report carries
   the SIM. Built as an EDGE fan-out from the fulfillment ops read
   (`readUnitSimsBySerialsOps`, `services/fulfillment/src/ops-read.ts`;
   merge in `apps/ops-edge/src/reports.controller.ts`, commit `dd29a74`), so
   the SIM still never reaches analytics and the JSON and CSV surfaces ride
   the SAME grant. VERIFIED, built and gated this session.

What the corpus is asked to confirm, in one ruling: the `fulfillment_ops_read`
column grant itself; full-value on the list versus masked-with-reveal; and the
downloadable CSV as a third surface. The code follows whatever is ruled; the
CSV was built only after the product approval and rides the grant without
widening it.

# Group D. Mirrors and for-awareness (no reversal, code ahead of corpus)

| Item | Status |
| ---- | ------ |
| **D-25, the ops return-upload channel.** `POST /ops/uploads/return` plus preview; new ops permission `ops:upload-return-file`; one shared ingest body with the class-6 vendor route so the two channels cannot drift; vendor resolved server-side from `batch.print_vndr` (M7/S16). The escalation is recorded as decided 2026-08-11 option A, so the RULING likely already exists; what needs mirroring is the PERMISSION STRING and the dual-channel shape, same class as G-10's ops permission strings. | VERIFIED in code (`apps/ops-edge/src/ops.controller.ts` D-25 block, `services/fulfillment/src/ops-config.ts`, read 15 Aug); the prior ruling itself CARRIED. |
| **R-3, upcoming return-sheet contract change.** Ruled 16 Aug: the return sheet gains an OPTIONAL vendor-reported Dispatch Date column, server clock as fallback. Not yet built (P1). Flagged now because it is an additive wire-contract change to a sheet a vendor fills. | For awareness |
| **R-2 / Q23 settled.** Duplicate VPA with Soundbox=Yes stays HELD (D-5/D-6 confirmed against BRD v1.6's looser "additional request can be for Soundbox" sentence); Soundbox=No duplicates stay ADDITIONAL for stickers and standees. No code change; the ruling pins the reading. | For awareness |
| **R-4 deferred.** The FR-04 six-column address split stays a composed Ship To string; splitting is a fact-shape change and will come back through this channel when picked up. | For awareness |

---

# Questions the corpus alone can answer (they gate built-ready tasks)

Restated from PLAN.md section 8 only where an architecture ruling, not a
product preference, is what is missing:

1. **Q26, the COLLATERAL close predicate** (subsumes Q20). A collateral
   replacement's terminal is DELIVERY, which only fulfillment sees; TMS
   carries no fulfillment status columns (T2/T12). Three ways out, none the
   repo's to pick: TMS holds a shipment reference (weakens T2/T12),
   fulfillment carries assignment ids on the shipment fact (fact-shape change,
   this channel), or analytics drives the close (a read model writing back,
   T2/T12 again). Until ruled, collateral cases close by hand.
2. **Q6, held-row retention.** Curing without the 18-field re-key requires
   persisting quarantined row content the code deliberately redacts. Full
   structured row, or only the cure-relevant fields? PII posture, so corpus.
3. **Q15, D-13 legacy scope.** Do pre-split null-group rows keep their
   documented two-AWB allowance (grandfathered, recommended), or is the rule
   retroactive? Gates T1.2, which finishes item 1 above.

---

# Suggested order for the architecture chat

1. **Group C, the ICCID**, because a live PII surface is ahead of its written
   confirmation and every week adds a surface that rides the grant.
2. **Item 5 (R-7)**, because it is this week's reversal and the built shape is
   narrower than the ruling's words; ratify the shape, not just the tier.
3. **Items 1 and Q15 together**, so T1.2 can close D-13 cleanly.
4. **Items 8 and 9 together**, the two missing facts; both are S23 topics and
   should be provisioned in one pass if ruled in.
5. Group A's remainder (2, 3, 4), Group B's remainder (6, 7, 10), then Group D
   mirrors.
