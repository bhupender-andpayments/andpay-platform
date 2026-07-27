-- Spec 10c: additive class-3 ops columns (S23 expand-contract, nullable, reversible)
-- and the fulfillment ops read role. No new table, no destructive DDL, no money.

-- Additive columns.
ALTER TABLE "shpt_status_event" ADD COLUMN IF NOT EXISTS "override_reason" text;
ALTER TABLE "pending_pool_entry" ADD COLUMN IF NOT EXISTS "released_by_actor" uuid;
ALTER TABLE "pending_pool_entry" ADD COLUMN IF NOT EXISTS "released_at" timestamptz(6);
ALTER TABLE "composed_artifact" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;
ALTER TABLE "composed_artifact" ADD COLUMN IF NOT EXISTS "superseded_at" timestamptz(6);
ALTER TABLE "intake_exception" ADD COLUMN IF NOT EXISTS "resolved_at" timestamptz(6);
ALTER TABLE "intake_exception" ADD COLUMN IF NOT EXISTS "resolved_by_actor" uuid;
ALTER TABLE "courier_status_exception" ADD COLUMN IF NOT EXISTS "resolved_at" timestamptz(6);
ALTER TABLE "courier_status_exception" ADD COLUMN IF NOT EXISTS "resolved_by_actor" uuid;

-- The ops read role (non-owner, own-schema only, C4-safe). Broad operator
-- visibility for the single soundbox ops team; flip trigger is per-team or
-- per-bank partitioning (a named policy hook below makes that a policy edit).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fulfillment_ops_read') THEN
    CREATE ROLE fulfillment_ops_read NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA fulfillment TO fulfillment_ops_read;
GRANT SELECT ON fulfillment.shpt, fulfillment.shpt_status_event, fulfillment.pending_pool_entry,
  fulfillment.batch, fulfillment.composed_artifact, fulfillment.vndr,
  fulfillment.intake_exception, fulfillment.courier_status_exception TO fulfillment_ops_read;

-- Broad-operator SELECT policies on the program-scoped tables, scoped TO the ops
-- read role only (so the tenant RESTRICTIVE read policies and the write gate are
-- unaffected). USING (true) is the honest v1 single-team visibility; a future
-- per-team flip narrows the USING here without touching grants.
CREATE POLICY "shpt_ops_read" ON "shpt" FOR SELECT TO fulfillment_ops_read USING (true);
CREATE POLICY "shpt_status_event_ops_read" ON "shpt_status_event" FOR SELECT TO fulfillment_ops_read USING (true);
CREATE POLICY "pending_pool_entry_ops_read" ON "pending_pool_entry" FOR SELECT TO fulfillment_ops_read USING (true);
CREATE POLICY "batch_ops_read" ON "batch" FOR SELECT TO fulfillment_ops_read USING (true);
CREATE POLICY "composed_artifact_ops_read" ON "composed_artifact" FOR SELECT TO fulfillment_ops_read USING (true);
