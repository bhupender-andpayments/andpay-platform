# UAT Rulings, 16 August 2026

Ruled by Rahul Bhardwaj in session, against BRD v1.6
(BRD_Soundbox_Dispatch_Tracking_System_v1.6.docx, received 15 Aug 2026) and the
reconciliation audit of `main` at `0baf919`. This file is the record the next
session reads before touching batching, returns, or the activation report.

Context established before the rulings, so nobody re-derives it:

- `main` at `0baf919` (PR #2, the ops portal rework plus the D-25 ops return
  channel) passes the full gate: build, lint, typecheck, 286 test files, 2274
  tests, exit 0. One trap found on the way: PR #2 added `pdf-lib` and
  `@andpay/bank-qr` to the ops portal, so a fresh pull FAILS `pnpm -r build`
  until `pnpm install` runs.
- BRD v1.6 differs from the repo's v1.4 copy by exactly four inserts: the
  FR-01b additional-request sentence, the 10 Aug image and Excel walkthrough
  notes, the 11 Aug split-dispatch-id note, and the 13 Aug revised damage
  workflow. Its internal revision table still ends at v1.4, flagged to the
  document owner.

## The rulings

**R-1. UAT posture: one supervised laptop via `pnpm demo`.** Deployment is
pending, so the harness shortcuts (permissive MFA accepting any six digits,
plain HTTP, co-booted edges with one in-process signer) are ACCEPTED for UAT.
None of them may ship; every one is already on `docs/plan/GO_LIVE_BLOCKERS.md`.

**R-2. Duplicate VPA: the current behavior stands.** Soundbox = Yes on a VPA
already in the system is HELD for review (no duplicate soundboxes, D-5 and D-6
confirmed). Soundbox = No with a duplicate VPA is allowed and tagged ADDITIONAL
for stickers and standees only. This settles Q23 (PLAN.md section 8): the
collision scan's current reading governs, and BRD v1.6's "additional request
can be for Soundbox" sentence does NOT mean an existing-VPA soundbox row is
auto-accepted. No code change; this ruling is the pin.

**R-3. Return sheet dispatch date: vendor-reported, optional, server fallback.**
Q21 is answered by accepting the recommendation. The return sheet gains an
OPTIONAL Dispatch Date column; when present and parseable it becomes
`shpt.dispatch_date`, when absent the server clock stays. A present but
unparseable date rejects that row only. Rationale: sheets arrive by email days
after the physical handover, so the server clock records upload day and skews
every ageing report. Build item, P1 (after the P0 list below).

**R-4. Address split: deferred.** FR-04's separate address columns (Address,
Address2, Address3, City, State, Pincode) stay composed as the single Ship To
string for UAT. Splitting is a wire-contract and fact-shape change with near
zero UAT value. Post-UAT item; needs a corpus decision when picked up.

**R-5. SIM No on the activation report CSV: APPROVED.** T5.3 is unblocked as a
product ruling. Build note: served via the fulfillment ops read (the column
grant from migration `20260812150000_unit_sim_qr_ops_read`), fanned out at the
edge, NOT projected into analytics, so the ICCID surface stays exactly where
the 12 Aug grant put it. STILL OWED regardless: the corpus confirmation that
migration's own header says is pending. This ruling widens the product surface;
it does not close the architecture question (PLAN.md Q25).

**R-6. Damage raise-from-UI: deferred, not descoped.** The revised FR-08
workflow (13 Aug, in BRD v1.6) is real and stays on the list, but is not a UAT
priority. For UAT the bank damage FILE upload drives the complete lifecycle
(replacement minted, linked, non-billable, normal batching, cases page with
manual status transitions), and that is disclosed to the UAT users.

**R-7. Per-bank batching overrides: ruled IN, needed for UAT.** This answers
Q12 and REVISES D-10 (which granted tenant and global tiers only): the
batching config gains a per-bank override tier. Resolution order is bank, then
tenant, then global; a bank with no row inherits. This is the one ruling that
reverses a corpus-recorded decision, so it rides the next corpus submission
(addition 11 below) and lands as code only alongside this record.

BUILT SHAPE (same day, commit `37413e9`), recorded because it is narrower than
the ruling's words: a bank-tier row carries MIN LOT SIZE ONLY, and a bank with
an override is evaluated on its own pooled count, its trigger claiming only
its own entries (BRD 5.3.3's evaluate-per-bank without re-graining the pool).
Max wait stays resolved at the pool tiers, because the max-wait timer is armed
per POOL (one saga instance per batch_pool row); a per-bank wait ceiling would
require per-bank pools or per-bank timers, which is a pool re-grain, a much
larger change deliberately not taken days before UAT. A bank-tier write that
supplies maxWaitSeconds is REJECTED, not ignored, and a table CHECK enforces
the same. If per-bank max wait is ever truly needed, it is a new decision, and
the honest implementation is pool-per-bank, not a config row.

## What this changes on the ledgers

- PLAN.md section 8: Q12 answered (R-7), Q21 answered (R-3), Q23 answered
  (R-2), Q25's product half answered (R-5, corpus half still open).
- Owed to the architecture corpus, extending PLAN.md section 7:
  11. The per-bank batching tier as a revision of D-10 (R-7).
  12. The activation report ICCID surface (R-5): product-approved here, the
      ICCID grant's corpus confirmation still pending.
- Deferred and disclosed for UAT: damage raise-from-UI (R-6), address split
  (R-4), AWB format validation (Q22 still unruled), mobile-based duplicate
  detection (FR-01b, unbuilt), email and QR Type capture (unbuilt), quarantine
  cure pre-fill (Q6 still unruled, the 18-field re-key stands).

## The UAT P0 list these rulings gate

1. This record. 2. Per-bank batching tier (R-7). 3. Scheduler added to
`pnpm demo` (today the harness boots no scheduler, so MAX_WAIT never fires).
4. SIM No on the activation report CSV (R-5). 5. UAT operator account seed.
6. UAT master data seed (banks, composition configs, couriers, print vendor,
per-bank batching rows, damage reasons). 7. The UAT runbook.
