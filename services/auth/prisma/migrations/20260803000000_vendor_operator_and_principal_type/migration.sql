-- Spec 14a Task 3 (S23 expand-contract). Additive migration:
-- (1) auth.vendor_operator: platform-only (no program_id, D121/4c pattern
--     mirrored from internal_principal), the class-3 vendor human login store.
--     Same RLS posture as every other auth table (ENABLE + FORCE + permissive
--     policy, S13 gate item 17) and an explicit per-table grant to auth_write
--     (NO ALTER DEFAULT PRIVILEGES, the 10d landmine that 403s under
--     SET LOCAL ROLE).
-- (2) principal_type text NOT NULL DEFAULT 'internal' added to mfa_enrollment,
--     refresh_token, and denylist so that every spec-04/spec-12 row is
--     byte-unchanged in DATA (D6). Only 'internal' | 'vendor_operator' are
--     valid; enforced with a CHECK (app-enforced enum, per the brief).
-- (3) mfa_enrollment can no longer FK to a single principal table now that a
--     second principal type exists; the FK is dropped (the app enforces valid
--     principal_ids now) and the principal-id index becomes a composite
--     (principal_id, principal_type) identity key.

-- CreateTable
CREATE TABLE "auth"."vendor_operator" (
    "id" UUID NOT NULL,
    "vndr_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by_actor" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_operator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_operator_vndr_id_username_key" ON "auth"."vendor_operator"("vndr_id", "username");

-- FORCE RLS posture (matches internal_principal and every sibling auth table).
ALTER TABLE "auth"."vendor_operator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth"."vendor_operator" FORCE ROW LEVEL SECURITY;
CREATE POLICY "vendor_operator_platform" ON "auth"."vendor_operator" USING (true) WITH CHECK (true);

-- Explicit per-table grant (NO ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE ON "auth"."vendor_operator" TO auth_write;

-- AddColumn: principal_type discriminator, additive, default-backfilled.
ALTER TABLE "auth"."mfa_enrollment" ADD COLUMN "principal_type" TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE "auth"."mfa_enrollment" ADD CONSTRAINT "mfa_enrollment_principal_type_check" CHECK ("principal_type" IN ('internal', 'vendor_operator'));

ALTER TABLE "auth"."refresh_token" ADD COLUMN "principal_type" TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE "auth"."refresh_token" ADD CONSTRAINT "refresh_token_principal_type_check" CHECK ("principal_type" IN ('internal', 'vendor_operator'));

ALTER TABLE "auth"."denylist" ADD COLUMN "principal_type" TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE "auth"."denylist" ADD CONSTRAINT "denylist_principal_type_check" CHECK ("principal_type" IN ('internal', 'vendor_operator'));

-- DropForeignKey: mfa_enrollment can no longer FK to a single principal table.
ALTER TABLE "auth"."mfa_enrollment" DROP CONSTRAINT "mfa_enrollment_principal_id_fkey";

-- The identity key becomes (principal_id, principal_type): drop the old
-- single-column index and replace it with the composite.
DROP INDEX "auth"."mfa_enrollment_principal_id_idx";
CREATE INDEX "mfa_enrollment_principal_id_principal_type_idx" ON "auth"."mfa_enrollment"("principal_id", "principal_type");
