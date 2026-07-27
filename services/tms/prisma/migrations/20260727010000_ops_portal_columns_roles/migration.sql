-- Spec 10c: additive quarantine resolution stamps and the tms ops read role.

ALTER TABLE "quarantine_row" ADD COLUMN IF NOT EXISTS "resolved_at" timestamptz(6);
ALTER TABLE "quarantine_row" ADD COLUMN IF NOT EXISTS "resolved_by_actor" uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tms_ops_read') THEN
    CREATE ROLE tms_ops_read NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA tms TO tms_ops_read;
GRANT SELECT ON tms.assignment, tms.quarantine_row, tms.pending_row, tms.ingest_file TO tms_ops_read;

CREATE POLICY "assignment_ops_read" ON "assignment" FOR SELECT TO tms_ops_read USING (true);
