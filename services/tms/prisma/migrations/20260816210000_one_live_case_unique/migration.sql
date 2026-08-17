-- One LIVE damage case per dispatch, enforced by the database
-- (REVIEW_REPORT.md F2, DP-3).
--
-- flagDamageOps checks for a non-Closed child before minting, but a check
-- inside one transaction cannot see another transaction's uncommitted child:
-- two concurrent flags with different Idempotency-Keys both pass the read and
-- both insert, and the (source_event_id, dispatch_group) unique does not
-- collide because the keys differ. This partial unique index is the rule
-- itself: at most one child per parent whose case is not Closed. Closed
-- children stay unbounded (repeat damage is real, a parent accumulates one
-- closed case per resolved complaint).
--
-- Prisma cannot express a partial unique index in schema.prisma, so this is
-- migration-only, like the batching bank-tier CHECKs. The service maps the
-- violation to the same 'conflict' the read-side check raises, so the caller
-- sees one 409 regardless of which guard fired.
--
-- No backfill concern: both mint paths have always written case_status='Open'
-- and the forward-only mover never NULLs it, so no existing pair can violate
-- the predicate. If this CREATE fails on an environment, that environment has
-- two live cases for one dispatch, which is exactly the defect, and the rows
-- must be reconciled by hand (close one) before deploy.
CREATE UNIQUE INDEX "assignment_one_live_case"
  ON "tms"."assignment" ("replacement_of")
  WHERE "replacement_of" IS NOT NULL AND "case_status" IS DISTINCT FROM 'Closed';
