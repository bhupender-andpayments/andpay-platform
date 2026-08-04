-- CreateTable
CREATE TABLE "damage_reason" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "damage_reason_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "damage_reason_code_key" ON "damage_reason"("code");

-- CreateIndex
CREATE UNIQUE INDEX "damage_reason_label_key" ON "damage_reason"("label");

-- Phase 3 Task 1 (BRD FR-08, FR-11): RLS, grants, and the seed rows for the new
-- damage_reason master table. Additive only (S23): no DROP, no ALTER of any
-- existing table, no ALTER DEFAULT PRIVILEGES (that landmine, spec 10d, is why
-- every NEW table since the tms_write/tms_ops_read "GRANT ... ALL TABLES IN
-- SCHEMA tms" migrations (20260727000000, 20260727010000) needs its OWN
-- explicit GRANT here: those broad grants only covered the tables that
-- existed AT THAT TIME, not tables created later).

-- Same platform-wide permissive v1 policy shape as every other non-program-
-- scoped tms table (pending_row_v1, quarantine_row_v1, ingest_file_v1, ...):
-- USING(true) WITH CHECK(true), no TO clause (defaults to PUBLIC), so it does
-- not itself gate anything table-level GRANTs don't already gate. damage_reason
-- carries no program_id (platform-only reference data, mirrors vndr in
-- fulfillment, D115), so there is no restrictive per-program predicate to add.
ALTER TABLE "damage_reason" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "damage_reason" FORCE ROW LEVEL SECURITY;
CREATE POLICY "damage_reason_v1" ON "damage_reason" USING (true) WITH CHECK (true);

-- tms_write: the ingest-validation SELECT (damage.ts) and the admin-CRUD
-- INSERT/UPDATE both run under this role (enterWriteRole/SET LOCAL ROLE
-- tms_write, entered FIRST per the spec 10d landmine). No DELETE path exists
-- in v1 (deactivate is a soft-delete via the active flag, never a hard
-- delete), but DELETE is granted anyway for uniformity with every other
-- tms_write table grant in this schema (all four privileges together).
GRANT SELECT, INSERT, UPDATE, DELETE ON tms.damage_reason TO tms_write;

-- tms_ops_read: the class-3 admin list view (listDamageReasons) runs under
-- this role, mirroring quarantine_row/ingest_file's grant in
-- 20260727010000_ops_portal_columns_roles.
GRANT SELECT ON tms.damage_reason TO tms_ops_read;

-- Seed the four BRD example reasons (FR-08, FR-11), ON CONFLICT DO NOTHING so
-- a re-run (or a future migrate replay in a fresh environment) is idempotent.
-- label is the human display text the ingest match compares against
-- (case/whitespace-insensitive, see damage.ts); code is the stable admin-
-- facing identifier.
INSERT INTO "damage_reason" (code, label, active, updated_at) VALUES
  ('battery_issue', 'battery issue', true, now()),
  ('physical_damage', 'physical damage', true, now()),
  ('device_not_working', 'device not working', true, now()),
  ('sim_issue', 'SIM issue', true, now())
ON CONFLICT DO NOTHING;
