-- STAGES + DAMAGE end-to-end (22 Aug 2026), tms half.

-- 1. actor_display on the case trail: the flagging/cancelling operator's login
--    handle, snapshotted AT WRITE TIME from the verified JWT claim (LeanClaim.hdl,
--    the one ruled exception to IDs-only). WHY A SNAPSHOT COLUMN: actor_id is an
--    auth-context principal id, and C4 forbids resolving it to a handle at read
--    time from another context's store. Same reasoning as pending_pool_entry's
--    merchant snapshot fields. Null when no human was behind the transition
--    (fact-driven moves) and on every row written before this column existed.
--    NEVER an authorization input, display only.
ALTER TABLE "damage_case_status_event" ADD COLUMN "actor_display" TEXT;

-- 2. The last unconstrained status vocabulary (STATUS_STAGES.md): demand_state.
--    Every other status column gained its CHECK on 20/21 Aug; this one was left
--    because 'closed' was believed dead, and the cancel flow then started
--    writing it (flag-damage.ts, the child leaves the demand pipeline). All
--    five values are therefore live and the constraint pins exactly them.
--    Verified against data before adding: SELECT DISTINCT demand_state shows a
--    subset of these five.
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_demand_state_check"
  CHECK ("demand_state" IN ('received', 'pooled-for-fulfillment', 'replacement-raised', 'activated', 'closed'));
