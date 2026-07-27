-- Tenant READ RLS predicates plus the per-context least-privilege role matrix
-- (S13, spec 10b, designs D-1 and D-2). Additive and reversible (S23): no DROP,
-- no destructive DDL, and no ALTER of the existing permissive _scoped policies.
-- The existing FOR ALL permissive policies (USING(true) WITH CHECK on the
-- scalar write key program_id) are left UNTOUCHED. This migration only ADDs a
-- RESTRICTIVE FOR SELECT policy scoped TO fulfillment_read, plus the two
-- schema-scoped context roles.
--
-- Read key vs write key: the read predicate uses app.program_ids (uuid[], via
-- = ANY set membership), which is DISTINCT from the write key app.program_id
-- (uuid scalar). Visibility is (OR of permissive policies) AND (AND of
-- restrictive policies), so under fulfillment_read a SELECT sees exactly
-- program_id IN app.program_ids. Fail closed: an unset app.program_ids makes
-- current_setting return NULL, so program_id = ANY(NULL::uuid[]) is NULL and
-- every row is hidden.

-- D-2: the two context roles, NOLOGIN NOSUPERUSER NOINHERIT, created
-- idempotently so a re-run is safe. Application roles are NEVER table owners
-- (the owner stays the migration superuser).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fulfillment_read') THEN
    CREATE ROLE fulfillment_read NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fulfillment_write') THEN
    CREATE ROLE fulfillment_write NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

-- USAGE on the OWN schema ONLY. Neither role gets USAGE on any other context's
-- schema, so a cross-schema query under either role fails with permission
-- denied for schema <other> (the database-level C4 backstop). No ALTER DEFAULT
-- PRIVILEGES, and no grant on any other context's schema.
GRANT USAGE ON SCHEMA fulfillment TO fulfillment_read, fulfillment_write;
GRANT SELECT ON ALL TABLES IN SCHEMA fulfillment TO fulfillment_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA fulfillment TO fulfillment_write;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fulfillment TO fulfillment_write;

-- D-1: the restrictive, role-scoped, set-membership READ predicate on each
-- program-scoped tenant surface. TO fulfillment_read scopes it to the read role
-- only, so the write role and the owner are unaffected (no write-path change).
-- batch_pool (internal, not a tenant surface) and unit/vndr (platform-only,
-- field-2 deferral) get NO read policy.
CREATE POLICY "pending_pool_entry_tenant_read" ON "pending_pool_entry"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));

CREATE POLICY "batch_tenant_read" ON "batch"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));

CREATE POLICY "composed_artifact_tenant_read" ON "composed_artifact"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));

CREATE POLICY "shpt_tenant_read" ON "shpt"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));

CREATE POLICY "shpt_status_event_tenant_read" ON "shpt_status_event"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));
