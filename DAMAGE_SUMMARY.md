# DAMAGE_SUMMARY.md. Damage and Replacement Workflow, feature/damage-workflow

Built 16 Aug 26 from the 13 Aug BRD update (decisions D-24 to D-31), which
voids the damage-file-upload design (old D-20 and D-21). Branch cut from local
main at 117c75b (the UAT P0 state). Full plan, audit, contracts, and recorded
decisions: DAMAGE_PLAN.md. Verified: full gate 286 files, 2302 tests, exit 0,
plus a live portal walkthrough of every decision (details in DAMAGE_PLAN.md
section 8).

## What was built

- Flag Damage (D-26, D-27, D-28): flagDamageOps in tms mints the non-billable
  replacement child on the flagged leg, one live case per dispatch (409 while
  a case is not Closed), reason from the master by CODE, required remarks on
  the row, flagged_by recorded, source_event_id 'ops-flag|<Idempotency-Key>',
  same transaction: replacement_raised fact, demand fact (the child enters
  the NORMAL pool, zero downstream special-casing), parent flipped to
  replacement-raised, ALLOW 6e audit. Migration: assignment.flagged_by.
- The case overlay (D-24) stays on the replacement assignment (no new table,
  DP-1). New: tms consumes fct.fulfillment.shipment.v1 and closes COLLATERAL
  replacement cases on DELIVERED (soundbox close on activation already
  existed). In-Progress transition unchanged (SENT_TO_VENDOR, DP-10).
- Reads: searchDispatchesByVpa (D-26) and countDamageCasesByStatus (D-31) in
  tms; edge routes GET /ops/dispatches/by-vpa, GET /ops/damage-cases/summary,
  POST /ops/records/:asgnId/flag-damage (ops:flag-damage).
- customer_support role (D-29): registered in both role configs; the single
  mutation ops:flag-damage; first read-side restriction machinery in ops-edge
  (read-restriction.ts) denying batch binary downloads, CSV export, and
  config views; the three formerly ungated upload previews now authorize.
- Portal: Flag damage dialog on the dispatch page (COLLATERAL counts 0..99
  total >= 1, SOUNDBOX fixed at one with no count input), VPA search and
  status chips with ?status= deep links on the Damage cases page, D-31 tile
  on the Command Center, CS-aware nav (display only, never authorization).
- Analytics (D-28 tail): a billable column on the damaged-replacement and
  soundbox-delivery reports; CSV carries it automatically. No row hidden.

## What was deleted (D-25)

The entire damage file ingest: tms damage.ts and damage-resolution.ts (the
O-1 seam, dissolved by D-26), the damage half of the bank-file adapter,
preview and commit service functions and edge routes, the portal upload page
and kind, the ops:upload-damage-file permission, and the tests of all of it.
No damage staging table existed to drop; historical file-born rows stay.

## Decision coverage

- D-24 case overlay: kept on the assignment, transitions event-driven, plus
  the new collateral DELIVERED close. D-25 no file ingest: deleted. D-26
  human resolves: VPA search plus per-leg flag, no auto-resolution left.
  D-27 three captures: reason master (others present), required remarks,
  counts (soundbox fixed 1 per D-6). D-28 child dispatch: non-billable,
  parent-linked, normal pipeline. D-29 CS role: built and live-verified.
  D-31 tile: live counts, drill-down to the filtered case list.

## Open questions (parked in DAMAGE_PLAN.md section 6)

OQ-1 flag-of-a-replacement allowed. OQ-2 the exact CS read line (JSON report
views and device detail stay visible). OQ-3 In-Progress at SENT_TO_VENDOR.
OQ-4 non-billable surfaced, never hidden. OQ-5 no backfill of file-born rows.

## Noticed, not changed

- A CS login lands on whatever route the session last held (for example the
  uploads index); nav hides it but routes are not client-gated, which is the
  pinned S24/T14 posture. A CS-specific landing default would be polish.
- Gate-published test facts replay into the next demo boot and dead-letter
  noisily (pre-existing, evidenced in two boots at different commits; spun
  off as its own task).
- The corpus submission for D-24 to D-31 ratification is not drafted here;
  the numbers come from the BRD update and this branch cites them.

Left ready for review on feature/damage-workflow. Not merged, not pushed
without the exact phrase.
