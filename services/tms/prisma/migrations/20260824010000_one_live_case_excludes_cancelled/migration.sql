-- THE ONE-LIVE-CASE INDEX LEARNS THAT CANCELLED IS NOT LIVE (24 Aug 2026).
--
-- The original predicate (20260816210000) was `case_status IS DISTINCT FROM
-- 'Closed'`, written before Cancelled existed (DAMAGE.md added the withdraw
-- flow on 21 Aug). A withdrawn case therefore still occupied the parent's
-- one-live-case slot, and re-flagging the parent -- the exact thing the cancel
-- flow exists to allow ("the original dispatch can be flagged again") -- hit
-- this index and answered "this dispatch already has a live damage case".
-- Found live on 24 Aug: cancel succeeded everywhere and the parent was still
-- unflaggable.
--
-- Cancelled joins Closed as a settled state. NULL-safe on purpose (IS DISTINCT
-- FROM), matching the original's shape, though in practice a replacement child
-- always carries a case_status from birth.
DROP INDEX "assignment_one_live_case";
CREATE UNIQUE INDEX "assignment_one_live_case"
  ON "assignment" ("replacement_of")
  WHERE "replacement_of" IS NOT NULL
    AND "case_status" IS DISTINCT FROM 'Closed'
    AND "case_status" IS DISTINCT FROM 'Cancelled';
