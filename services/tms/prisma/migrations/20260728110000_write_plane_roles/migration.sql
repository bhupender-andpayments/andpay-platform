-- Spec 10d Task 3: tms_write and tms_read already exist (spec 10b/10c) with
-- SELECT, INSERT, UPDATE, DELETE on every tms table (assignment, pending_row,
-- merchant_projection, tenant_projection, quarantine_row, ingest_file,
-- outbox, inbox) plus schema USAGE; verified against the live dev database
-- (information_schema.role_table_grants) before writing this migration, so no
-- new GRANT is needed for tms_write. tms has no sequences (UUID PKs only), so
-- there is nothing to grant there either. No new WITH CHECK write policy is
-- needed anywhere (the spec 07.B/10c policies already bind PUBLIC, not a
-- specific role).
--
-- This migration only creates tms_relay (Fork B, harness-proven in Task 5):
-- the outbox drain role, SELECT/UPDATE on tms.outbox only, no program
-- binding (outbox is WITH CHECK (true), a cross-program-by-design scan).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tms_relay') THEN
    CREATE ROLE tms_relay NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA tms TO tms_relay;
GRANT SELECT, UPDATE ON tms.outbox TO tms_relay;
