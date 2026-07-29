-- Spec 10d Task 6: the auth_write role. Auth has ZERO program-scoped tables
-- (spec 04 field 9): every auth table is WITH CHECK (true), so this is
-- M-ROLE ONLY, no new WITH CHECK policy is needed or added here (unlike
-- identity/tms/fulfillment's *_scoped predicates). auth_appender (Task 5,
-- migration 20260728120000_appender_role) already exists and is a SEPARATE
-- role for the authz_audit hash-chain appender; it is not touched here.
--
-- Grants follow the ACTUAL access paths in docs/spec_10d_writer_inventory.md
-- (AUTH section), least-privilege:
--   - refresh_token, vendor_credential, denylist: the live writers
--     (issueRefreshFamily/rotateRefresh, issueVendorCredential/
--     revokeVendorCredential, addToDenylist). SELECT, INSERT, UPDATE (no
--     writer ever deletes a row).
--   - internal_principal: login's findUnique only. SELECT, no INSERT/UPDATE.
--   - outbox: issueVendorCredential/revokeVendorCredential enqueue facts
--     inside their auth_write-scoped tx (credential fact, credential-config,
--     and the authz.audit ENQUEUE, which is an outbox INSERT, not an
--     authz_audit table write). SELECT, INSERT.
--   - inbox: NOT granted. No auth_write path calls onceWithin; onceWithin/
--     inbox dedup belongs to auth_appender's appendAuthzAudit chain only
--     (Task 5), a separate role.
--   - sequences: NONE. Every auth table id is uuid/text (schema.prisma has no
--     autoincrement/serial column anywhere in this schema).
-- NO grant on auth.session / auth.mfa_enrollment (no live write path this
-- slice, S23). NO grant on auth.authz_audit (auth_appender only, Task 5).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_write') THEN
    CREATE ROLE auth_write NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA auth TO auth_write;

GRANT SELECT, INSERT, UPDATE ON auth.refresh_token, auth.vendor_credential, auth.denylist TO auth_write;
GRANT SELECT ON auth.internal_principal TO auth_write;
GRANT SELECT, INSERT ON auth.outbox TO auth_write;
