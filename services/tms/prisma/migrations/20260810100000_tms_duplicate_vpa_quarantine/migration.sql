-- Soundbox duplicate-VPA quarantine (ruling 2026-08-10). SUPERSEDES the D-2
-- reading "a flag, never a gate" for SOUNDBOX rows only: a soundbox row whose
-- VPA we already hold is now HELD for review instead of ingesting silently.
-- Sticker/standee-only rows (soundbox = false) keep the flag-only counters
-- exactly as they were, so nothing that was accepted before is rejected now
-- unless it asks for a second soundbox on a VPA we already serve.
--
-- Fully ADDITIVE, like 20260804170000_tms_branch_code: one nullable column and
-- two indexes. No table is created, no column is dropped or retyped, and no
-- RLS policy changes (quarantine_row keeps its permissive v1 quarantine_row_v1
-- policy from 20260723103031_tms_domain).
--
-- No GRANT is needed either. Postgres table-level privileges cover columns
-- added later, and quarantine_row already carries the two grants this column is
-- read and written through: SELECT to tms_ops_read
-- (20260727010000_ops_portal_columns_roles) and the full
-- SELECT/INSERT/UPDATE/DELETE to tms_write recorded as pre-existing and
-- re-verified against information_schema.role_table_grants in
-- 20260728110000_write_plane_roles. So the ops queue read and the ingest
-- quarantine INSERT both reach `detail` with no privilege change.

-- The quarantine record's structured detail, carrying
-- {"duplicateOf":{"kind","reference","merchantDisplayName"}} for a
-- duplicate_vpa_soundbox hold so the ops queue can NAME the original the row
-- collides with ("VPA -> original") instead of asking an operator to go and
-- find it. Nullable because every other reason code writes no detail at all,
-- and JSONB rather than a set of columns because the shape is per-reason: a
-- future reason with different evidence adds no migration.
ALTER TABLE "quarantine_row" ADD COLUMN "detail" JSONB;

-- The gate reads both tables on EVERY preview and EVERY commit, matching on
-- lower(vpa_value) (merchant identity is `v1:vpa:<lower(vpa)>` per the D1
-- interim, so two casings are one merchant). Neither table had ANY index on
-- vpa_value before this migration (verified across every tms migration:
-- 20260723103031_tms_domain creates only assignment_source_event_id_key and
-- pending_row_correlation_id_key), so both scans were sequential and grow with
-- the whole ingest history rather than with the file being uploaded.
--
-- FUNCTIONAL indexes, so they must live in the migration and NOT in
-- schema.prisma: the Prisma schema DSL has no functional-index syntax. This is
-- the same migration-only treatment, and the same reason, as the normalized
-- unique index on damage_reason (see the comment on model DamageReason in
-- services/tms/prisma/schema.prisma and
-- 20260804165617_damage_reason_label_normalized_unique).
CREATE INDEX "pending_row_vpa_value_lower_idx" ON "pending_row" (lower("vpa_value"));

CREATE INDEX "assignment_vpa_value_lower_idx" ON "assignment" (lower("vpa_value"));
