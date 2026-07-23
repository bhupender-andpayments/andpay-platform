-- CreateTable
CREATE TABLE "assignment" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "merchant_display_name" TEXT NOT NULL,
    "merchant_legal_name" TEXT NOT NULL,
    "merchant_mcc" TEXT NOT NULL,
    "bank_reference_code" TEXT NOT NULL,
    "bank_display_name" TEXT NOT NULL,
    "ship_to_address" TEXT NOT NULL,
    "qr_value" TEXT NOT NULL,
    "vpa_value" TEXT NOT NULL,
    "soundbox" BOOLEAN NOT NULL,
    "standee_count" INTEGER NOT NULL,
    "sticker_count" INTEGER NOT NULL,
    "billable" BOOLEAN NOT NULL,
    "replacement_of" UUID,
    "damage_reason" TEXT,
    "bank_remarks" TEXT,
    "case_status" TEXT,
    "demand_state" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6),
    "source_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_row" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "correlation_id" TEXT NOT NULL,
    "tenant_reference" TEXT NOT NULL,
    "soundbox" BOOLEAN NOT NULL,
    "standee_count" INTEGER NOT NULL,
    "sticker_count" INTEGER NOT NULL,
    "qr_value" TEXT NOT NULL,
    "vpa_value" TEXT NOT NULL,
    "ship_to_address" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_projection" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "mcc" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_projection" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bank_reference_code" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_file" (
    "file_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tenant_reference" TEXT NOT NULL,
    "row_total" INTEGER NOT NULL DEFAULT 0,
    "row_accepted" INTEGER NOT NULL DEFAULT 0,
    "row_rejected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_file_pkey" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "quarantine_row" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_id" TEXT NOT NULL,
    "row_no" INTEGER NOT NULL,
    "raw_row" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_row_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assignment_source_event_id_key" ON "assignment"("source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_row_correlation_id_key" ON "pending_row"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "quarantine_row_file_id_row_no_key" ON "quarantine_row"("file_id", "row_no");

-- FORCE RLS posture (S13, gate item 17 PARTIAL), spec 06 section 9. RLS is
-- enabled and FORCED on every tms table under the staged per-workload role.
-- Superusers bypass RLS, so the write-gate bites once a non-superuser workload
-- role connects; the source_event_id / correlation_id UNIQUEs (constraints, not
-- RLS) bite now.
--
-- assignment is the only Program-scoped table (07.A class 1). It is created on
-- the enrollment fact, when prog_ is known, so its program_id write-gate is
-- SET LOCAL app.program_id (07.B). Reads open in v1.
ALTER TABLE "assignment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assignment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assignment_scoped" ON "assignment" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

-- pending_row, merchant_projection, tenant_projection, ingest_file, and
-- quarantine_row are written at ingest BEFORE Identity resolves the Program, or
-- are event-fed read-models; there is no prog_ to gate on (ratified this
-- session, resolving the section 2 vs section 9 conflict). FORCE RLS with
-- permissive policies in v1; the tenant-portal read predicate is deferred to
-- step 9.
ALTER TABLE "pending_row" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_row" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pending_row_v1" ON "pending_row" USING (true) WITH CHECK (true);

ALTER TABLE "merchant_projection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_projection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "merchant_projection_v1" ON "merchant_projection" USING (true) WITH CHECK (true);

ALTER TABLE "tenant_projection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_projection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_projection_v1" ON "tenant_projection" USING (true) WITH CHECK (true);

ALTER TABLE "ingest_file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingest_file" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ingest_file_v1" ON "ingest_file" USING (true) WITH CHECK (true);

ALTER TABLE "quarantine_row" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quarantine_row" FORCE ROW LEVEL SECURITY;
CREATE POLICY "quarantine_row_v1" ON "quarantine_row" USING (true) WITH CHECK (true);

-- outbox and inbox were created RLS-free in the init migration; force a uniform
-- posture now (spec 05 precedent), permissive.
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_platform" ON "outbox" USING (true) WITH CHECK (true);

ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inbox_platform" ON "inbox" USING (true) WITH CHECK (true);
