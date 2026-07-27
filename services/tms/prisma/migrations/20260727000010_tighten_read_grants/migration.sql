-- Tighten the tms_read grant to the tenant-facing table only (S13
-- least-privilege follow-up to 20260727000000_tenant_read_rls_roles).
--
-- That migration granted SELECT ON ALL TABLES IN SCHEMA tms TO tms_read,
-- which lets tms_read SELECT, cross-tenant and RLS-ungated, from tables that
-- carry no restrictive tenant-read policy (ingest_file, quarantine_row,
-- pending_row, tenant_projection, merchant_projection, outbox, inbox). The
-- restrictive policy added by that migration only protects "assignment"; a
-- broad schema-wide grant leaves every other table's rows fully visible to
-- the read role regardless of RLS.
--
-- This migration REVOKEs the broad grant and re-GRANTs SELECT on ONLY the
-- tenant-facing table (assignment), which is the sole table carrying the
-- assignment_tenant_read restrictive policy. Additive and reversible (S23):
-- REVOKE/GRANT are not destructive DDL (no DROP, no data loss), and re-running
-- this migration is idempotent (REVOKE and GRANT are both no-ops if already
-- in the target state). The tms_write role and its broad own-schema DML are
-- UNCHANGED; the deferred write-workload role is out of scope here.
REVOKE SELECT ON ALL TABLES IN SCHEMA tms FROM tms_read;
GRANT SELECT ON tms.assignment TO tms_read;
