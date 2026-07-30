-- Q5 policy hardening (spec 11 task 4): make the analytics_read membership
-- branch fail-closed to 0 rows on a REUSED connection, restoring the ratified
-- ruling's G2 intent.
--
-- WHY: set_config('app.program_ids', ..., true) is transaction-LOCAL, but once
-- the custom GUC placeholder has been introduced on a connection it reverts to
-- the empty string '' (NOT NULL) after the tx. The original policy cast the GUC
-- unconditionally: current_setting('app.program_ids', true)::uuid[]. ''::uuid[]
-- raises 22P02 (malformed array literal ""), and inside an RLS policy qual the
-- OR does NOT short-circuit (unlike a scalar SELECT), so even the cross_tenant
-- branch being true does not save it: on any connection that has ever served an
-- own-scope read, a subsequent crossTenant read OR a GUC-less read THROWS
-- instead of fail-closing to 0 rows. NULLIF(..., '') maps the reverted empty
-- string back to NULL, so program_id = ANY(NULL) is NULL (no match) and the
-- policy returns 0 rows, matching the ruling's documented "= ANY(NULL) NULL so
-- 0 rows" fail-closed contract regardless of connection history.
--
-- Additive and reversible (S23): touches ONLY this policy in the analytics
-- schema. Postgres has no CREATE OR REPLACE POLICY, so DROP + re-CREATE it
-- IDENTICALLY except the membership operand. RESTRICTIVE FOR SELECT TO
-- analytics_read and the cross_tenant branch are unchanged.
DROP POLICY IF EXISTS "dispatch_row_analytics_read" ON analytics.dispatch_row;
CREATE POLICY "dispatch_row_analytics_read" ON analytics.dispatch_row
  AS RESTRICTIVE FOR SELECT TO analytics_read
  USING (
    current_setting('app.cross_tenant', true) = 'true'
    OR program_id = ANY (NULLIF(current_setting('app.program_ids', true), '')::uuid[])
  );
