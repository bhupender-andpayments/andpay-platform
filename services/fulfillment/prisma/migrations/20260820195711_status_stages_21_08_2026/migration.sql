-- AlterTable
ALTER TABLE "unit" ADD COLUMN     "activated_by" UUID;

-- CreateTable
CREATE TABLE "pool_entry_status_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pool_entry_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status_source" TEXT NOT NULL,
    "actor_id" UUID,
    "trace_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pool_entry_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_status_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "unit_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status_source" TEXT NOT NULL,
    "actor_id" UUID,
    "trace_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_status_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batch_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status_source" TEXT NOT NULL,
    "actor_id" UUID,
    "trace_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pool_entry_status_event_pool_entry_id_idx" ON "pool_entry_status_event"("pool_entry_id");

-- CreateIndex
CREATE INDEX "unit_status_event_unit_id_idx" ON "unit_status_event"("unit_id");

-- CreateIndex
CREATE INDEX "batch_status_event_batch_id_idx" ON "batch_status_event"("batch_id");

-- RLS: pool_entry_status_event and batch_status_event are program-scoped
-- (their parent rows carry program_id), matching shpt_status_event's exact
-- shape (20260725160000_courier_status). unit_status_event is platform-wide,
-- since unit itself carries no program_id, matching device_inventory_upload's
-- permissive shape (20260805110000_device_inventory_upload_ledger).
ALTER TABLE "pool_entry_status_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pool_entry_status_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pool_entry_status_event_scoped" ON "pool_entry_status_event"
  USING (true)
  WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);
CREATE POLICY "pool_entry_status_event_tenant_read" ON "pool_entry_status_event"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));
CREATE POLICY "pool_entry_status_event_ops_read" ON "pool_entry_status_event"
  FOR SELECT TO fulfillment_ops_read USING (true);

ALTER TABLE "batch_status_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_status_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "batch_status_event_scoped" ON "batch_status_event"
  USING (true)
  WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);
CREATE POLICY "batch_status_event_tenant_read" ON "batch_status_event"
  AS RESTRICTIVE FOR SELECT TO fulfillment_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));
CREATE POLICY "batch_status_event_ops_read" ON "batch_status_event"
  FOR SELECT TO fulfillment_ops_read USING (true);

ALTER TABLE "unit_status_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unit_status_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "unit_status_event_v1" ON "unit_status_event" USING (true) WITH CHECK (true);
GRANT SELECT ON "unit_status_event" TO fulfillment_ops_read;

-- These three tables are created AFTER the bulk GRANT ... ON ALL TABLES
-- (20260727000100_tenant_read_rls_roles), which does not reach future tables,
-- exactly the reason device_inventory_upload's own migration states for its
-- own explicit grant.
GRANT SELECT, INSERT ON "pool_entry_status_event" TO fulfillment_write;
GRANT SELECT, INSERT ON "unit_status_event" TO fulfillment_write;
GRANT SELECT, INSERT ON "batch_status_event" TO fulfillment_write;
GRANT SELECT ON "pool_entry_status_event" TO fulfillment_read;
GRANT SELECT ON "batch_status_event" TO fulfillment_read;

-- CHECK constraints (STATUS_STAGES.md): every status column pinned to its
-- vocabulary at the database, not just in application code. pool_status now
-- carries a fourth value, CANCELLED, for the damage cancel-request flow
-- (DAMAGE.md); dispatch_state is unaffected by that flow, so it stays three.
ALTER TABLE "unit" ADD CONSTRAINT "unit_status_check"
  CHECK ("status" IN ('IN_STOCK', 'PRINTED', 'DISPATCHED', 'DELIVERED', 'DAMAGED', 'RETURNED'));
ALTER TABLE "pending_pool_entry" ADD CONSTRAINT "pending_pool_entry_pool_status_check"
  CHECK ("pool_status" IN ('POOLED', 'HELD', 'BATCHED', 'CANCELLED'));
ALTER TABLE "pending_pool_entry" ADD CONSTRAINT "pending_pool_entry_dispatch_state_check"
  CHECK ("dispatch_state" IS NULL OR "dispatch_state" IN ('QR_GENERATED', 'SENT_TO_VENDOR', 'DISPATCHED_BY_VENDOR'));
ALTER TABLE "batch" ADD CONSTRAINT "batch_status_check"
  CHECK ("status" IN ('BATCHED', 'SENT_TO_PRINT_VENDOR', 'CLOSED'));
ALTER TABLE "shpt" ADD CONSTRAINT "shpt_status_check"
  CHECK ("status" IN ('DISPATCHED_BY_VENDOR', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED'));

-- Backfill (STATUS_STAGES.md rail rule): rows written before these log tables
-- existed get one synthetic event carrying their CURRENT status, so the rail
-- shows at least their present position rather than an empty trail. Marked
-- source='backfill' so it is never confused with a real transition.
INSERT INTO "unit_status_event" (unit_id, status, occurred_at, status_source, trace_id)
  SELECT id, status, updated_at, 'backfill', 'backfill'
  FROM "unit";

INSERT INTO "pool_entry_status_event" (pool_entry_id, program_id, status, occurred_at, status_source, trace_id)
  SELECT id, program_id, pool_status, created_at, 'backfill', 'backfill'
  FROM "pending_pool_entry";

INSERT INTO "batch_status_event" (batch_id, program_id, status, occurred_at, status_source, trace_id)
  SELECT id, program_id, status, created_at, 'backfill', 'backfill'
  FROM "batch";
