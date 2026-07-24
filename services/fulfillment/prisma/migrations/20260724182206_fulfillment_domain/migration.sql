-- CreateTable
CREATE TABLE "vndr" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vndr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "product_type" TEXT NOT NULL,
    "manufacturer_vndr" UUID NOT NULL,
    "batch" UUID,
    "status" TEXT NOT NULL,
    "device_serial" TEXT,
    "device_qr" JSONB,
    "shipment" UUID,
    "printed_for_merchant" UUID,
    "location" TEXT,
    "qr_string" TEXT,
    "procured" INTEGER,
    "allocated" INTEGER,
    "printed" INTEGER,
    "dispatched" INTEGER,
    "delivered" INTEGER,
    "returned" INTEGER,
    "scrapped" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_pool_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asgn_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "soundbox" BOOLEAN NOT NULL,
    "standee_count" INTEGER NOT NULL,
    "sticker_count" INTEGER NOT NULL,
    "billable" BOOLEAN NOT NULL,
    "merchant_display_name" TEXT NOT NULL,
    "merchant_legal_name" TEXT NOT NULL,
    "merchant_mcc" TEXT NOT NULL,
    "bank_reference_code" TEXT NOT NULL,
    "bank_display_name" TEXT NOT NULL,
    "ship_to_address" TEXT NOT NULL,
    "qr_value" TEXT NOT NULL,
    "vpa_value" TEXT NOT NULL,
    "pool_status" TEXT NOT NULL,
    "batch" UUID,
    "source_event_id" TEXT NOT NULL,
    "trace_id" TEXT NOT NULL,
    "held_by_actor" UUID,
    "held_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pending_pool_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "print_vndr" UUID,
    "status" TEXT NOT NULL,
    "trigger_reason" TEXT NOT NULL,
    "triggered_by_actor" UUID,
    "unit_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_pool" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "pm_instance_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_exception" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vndr_id" UUID NOT NULL,
    "file_id" TEXT NOT NULL,
    "row_ref" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saga_instance" (
    "id" UUID NOT NULL,
    "flow_type" TEXT NOT NULL,
    "flow_version" INTEGER NOT NULL,
    "current_step" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saga_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saga_step" (
    "instance_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_class" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saga_step_pkey" PRIMARY KEY ("instance_id","name")
);

-- CreateTable
CREATE TABLE "saga_timer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instance_id" UUID NOT NULL,
    "fire_at" TIMESTAMPTZ(6) NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMPTZ(6),

    CONSTRAINT "saga_timer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "unit_device_serial_key" ON "unit"("device_serial");

-- CreateIndex
CREATE UNIQUE INDEX "pending_pool_entry_asgn_id_key" ON "pending_pool_entry"("asgn_id");

-- CreateIndex
CREATE UNIQUE INDEX "batch_pool_tenant_id_program_id_key" ON "batch_pool"("tenant_id", "program_id");

-- CreateIndex
CREATE INDEX "saga_timer_status_fire_at_idx" ON "saga_timer"("status", "fire_at");

-- AddForeignKey
ALTER TABLE "saga_step" ADD CONSTRAINT "saga_step_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "saga_instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saga_timer" ADD CONSTRAINT "saga_timer_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "saga_instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FORCE RLS posture (S13), spec 07 field 9. Program-scoped tables get the
-- program_id write-gate (07.B); vndr/unit (platform-only inventory) and the
-- saga_* engine tables and outbox/inbox are permissive in v1 under the staged
-- per-workload role. current_setting('app.program_id', true) returns NULL when
-- unset (missing_ok), fail-closed under the non-superuser role.
ALTER TABLE "pending_pool_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_pool_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pending_pool_entry_scoped" ON "pending_pool_entry" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "batch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "batch_scoped" ON "batch" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "batch_pool" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_pool" FORCE ROW LEVEL SECURITY;
CREATE POLICY "batch_pool_scoped" ON "batch_pool" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "vndr" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vndr" FORCE ROW LEVEL SECURITY;
CREATE POLICY "vndr_v1" ON "vndr" USING (true) WITH CHECK (true);

ALTER TABLE "unit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "unit_v1" ON "unit" USING (true) WITH CHECK (true);

ALTER TABLE "intake_exception" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intake_exception" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intake_exception_v1" ON "intake_exception" USING (true) WITH CHECK (true);

ALTER TABLE "saga_instance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_instance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saga_instance_v1" ON "saga_instance" USING (true) WITH CHECK (true);

ALTER TABLE "saga_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_step" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saga_step_v1" ON "saga_step" USING (true) WITH CHECK (true);

ALTER TABLE "saga_timer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_timer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saga_timer_v1" ON "saga_timer" USING (true) WITH CHECK (true);

ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_platform" ON "outbox" USING (true) WITH CHECK (true);

ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inbox_platform" ON "inbox" USING (true) WITH CHECK (true);
