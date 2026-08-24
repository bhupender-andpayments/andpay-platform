-- STAGES + DAMAGE end-to-end (22 Aug 2026), fulfillment half: actor_display on
-- all four status trails. The operator's login handle, snapshotted AT WRITE
-- TIME from the verified JWT claim (LeanClaim.hdl) via ops-edge's
-- Gated.actorDisplay. WHY A SNAPSHOT: actor_id is an auth principal id and C4
-- forbids a read-time join to another context to resolve it; the handle is
-- carried for display exactly the way merchant_display_name is. Null when the
-- writer is a file/consumer door with no human behind it, and on every row
-- older than this column. NEVER an authorization input.
--
-- No new GRANT or POLICY needed: all four tables already carry their RLS
-- policies and role grants at TABLE level (20260820195711 + 20260820210000 for
-- the three new trails, spec 10c for shpt_status_event), and a table-level
-- SELECT/INSERT covers added columns.
ALTER TABLE "shpt_status_event" ADD COLUMN "actor_display" TEXT;
ALTER TABLE "pool_entry_status_event" ADD COLUMN "actor_display" TEXT;
ALTER TABLE "unit_status_event" ADD COLUMN "actor_display" TEXT;
ALTER TABLE "batch_status_event" ADD COLUMN "actor_display" TEXT;
