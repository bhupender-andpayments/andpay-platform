-- AlterTable: spec 08 dispatch state + D116 ship-to amendment/lock columns,
-- plus the controller-added spec 06a recipient contact snapshot
-- (ship_to_contact_name/ship_to_mobile). All seven are genuinely absent, so
-- these are plain ADD COLUMN, not part of the CREATE TABLE above.
ALTER TABLE "pending_pool_entry" ADD COLUMN "dispatch_state" TEXT;
ALTER TABLE "pending_pool_entry" ADD COLUMN "merchant_id" UUID;
ALTER TABLE "pending_pool_entry" ADD COLUMN "ship_to_amendment_seq" INTEGER;
ALTER TABLE "pending_pool_entry" ADD COLUMN "ship_to_superseded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pending_pool_entry" ADD COLUMN "superseded_ship_to" TEXT;
ALTER TABLE "pending_pool_entry" ADD COLUMN "ship_to_contact_name" TEXT;
ALTER TABLE "pending_pool_entry" ADD COLUMN "ship_to_mobile" TEXT;

-- CreateTable
CREATE TABLE "composed_artifact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asgn_id" UUID NOT NULL,
    "btch_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "artifact_type" TEXT NOT NULL,
    "asset_reference" TEXT NOT NULL,
    "label_display_name" TEXT NOT NULL,
    "label_qr" TEXT NOT NULL,
    "bank_config_ref" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "composed_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shpt" (
    "id" UUID NOT NULL,
    "awb" TEXT NOT NULL,
    "courier_partner" UUID,
    "status" TEXT NOT NULL,
    "dispatch_date" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shpt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_composition_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "bank_code" TEXT NOT NULL,
    "logo_master_ref" TEXT NOT NULL,
    "logo_derivative_ref" TEXT NOT NULL,
    "branding_params" JSONB NOT NULL,
    "image_templates" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bank_composition_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shpt_awb_key" ON "shpt"("awb");

-- CreateIndex
CREATE UNIQUE INDEX "bank_composition_config_tenant_id_bank_code_key" ON "bank_composition_config"("tenant_id", "bank_code");

-- FORCE RLS posture (S13), spec 08 outbound. composed_artifact/shpt are
-- PROGRAM-SCOPED (program_id write-gate, matching pending_pool_entry/batch/
-- batch_pool from spec 07); bank_composition_config is a tenant-keyed
-- reference table, permissive in v1 (write-gated at step 9). RLS blocks
-- copied VERBATIM from 20260724182206_fulfillment_domain/migration.sql:171-193.
ALTER TABLE "composed_artifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "composed_artifact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "composed_artifact_scoped" ON "composed_artifact" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "shpt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shpt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shpt_scoped" ON "shpt" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "bank_composition_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_composition_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "bank_composition_config_v1" ON "bank_composition_config" USING (true) WITH CHECK (true);
