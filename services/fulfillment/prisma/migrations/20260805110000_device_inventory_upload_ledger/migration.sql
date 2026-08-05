-- Phase 5 Task 1 (D-G, FR-01a V2): the ops device-inventory upload-audit
-- ledger, a NEW functional requirement distinct from the 6e authz audit
-- ("Maintain an audit log of file uploads: uploader, timestamp, row counts,
-- status."). Modeled on TMS's ingest_file, plus the uploader column ingest_file
-- lacks. Additive/new-table only (S23 expand-contract).

-- CreateTable
CREATE TABLE "device_inventory_upload" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "file_id" TEXT NOT NULL,
    "uploader" UUID NOT NULL,
    "manufacturer_vndr" UUID NOT NULL,
    "row_total" INTEGER NOT NULL,
    "row_accepted" INTEGER NOT NULL,
    "row_flagged" INTEGER NOT NULL,
    "row_invalid" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_inventory_upload_pkey" PRIMARY KEY ("id")
);

-- Permissive FORCE RLS (v1), matching every other platform-only ledger table
-- (intake_exception, batching_config): this is a platform-wide upload
-- ledger, not tenant/program-scoped, so visibility and write are gated by the
-- GRANTs below, not by a program predicate.
ALTER TABLE "device_inventory_upload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_inventory_upload" FORCE ROW LEVEL SECURITY;
CREATE POLICY "device_inventory_upload_v1" ON "device_inventory_upload" USING (true) WITH CHECK (true);

-- fulfillment_write inserts the ledger row inside the SAME transaction as the
-- intake effect (ingestOpsDeviceInventory). device_inventory_upload is
-- created AFTER the bulk GRANT ... ON ALL TABLES ... TO fulfillment_write
-- (20260727000100), so it needs its own explicit table grant (the bulk grant
-- does not reach new tables).
GRANT SELECT, INSERT ON "device_inventory_upload" TO fulfillment_write;

-- fulfillment_ops_read backs a future ops read surface (none built in this
-- task), mirroring every other ledger's read grant (batching_config,
-- bank_composition_config). The table's own RLS policy is unscoped
-- (USING(true)), so read visibility is gated purely by this GRANT.
GRANT SELECT ON "device_inventory_upload" TO fulfillment_ops_read;
