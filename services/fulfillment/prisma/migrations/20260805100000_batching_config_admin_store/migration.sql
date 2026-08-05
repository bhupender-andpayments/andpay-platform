-- Phase 3 Task 6 (BRD 5.3.2): the admin-writable batching parameter store,
-- revising S23's code-as-config. Holds Minimum Lot Size + Maximum Wait Time
-- for one scope (GLOBAL default | per-tenant | per-(tenant, program)).
-- Additive/new-table only (S23 expand-contract): an EMPTY table reproduces
-- today's behavior EXACTLY (the code DEFAULT, 50 / 7 days, for every pool via
-- resolvePoolConfig's fallback).

-- CreateTable
CREATE TABLE "batching_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- Scope columns, '' empty-string sentinel (NEVER NULL, mirroring
    -- bank_composition_config's branch_code / T5a): a GLOBAL default row is
    -- ('', ''); a per-tenant default is (tenant_wire, ''); a per-(tenant,
    -- program) override is (tenant_wire, program_wire). Wire ids (public form),
    -- matching S23's original OVERRIDES / TENANT_DEFAULTS keys.
    "tenant_wire" TEXT NOT NULL DEFAULT '',
    "program_wire" TEXT NOT NULL DEFAULT '',
    "min_lot_size" INTEGER NOT NULL,
    "max_wait_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "batching_config_pkey" PRIMARY KEY ("id")
);

-- Exactly one row per scope. Because the two scope columns are NEVER NULL (the
-- '' sentinel), a plain UNIQUE enforces the invariant with no NULL-distinct
-- gotcha (the same technique as bank_composition_config's branch_code, T5a),
-- and gives upsertBatchingConfig its ON CONFLICT target.
CREATE UNIQUE INDEX "batching_config_tenant_wire_program_wire_key"
  ON "batching_config"("tenant_wire", "program_wire");

-- Permissive FORCE RLS (v1), matching bank_composition_config_v1: this is
-- platform master data, not program-scoped; visibility and write are gated by
-- the GRANTs below, not by a program predicate. The read at the batch-trigger
-- call sites (resolvePoolConfig) is therefore program-context-independent.
ALTER TABLE "batching_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batching_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY "batching_config_v1" ON "batching_config" USING (true) WITH CHECK (true);

-- fulfillment_write performs the admin upsert (upsertBatchingConfig) AND reads
-- the table during batch triggering (resolvePoolConfig at the write-plane call
-- sites, under this role). batching_config is created AFTER the bulk
-- GRANT ... ON ALL TABLES ... TO fulfillment_write (20260727000100), so it
-- needs its own explicit table grant (the bulk grant does not reach new tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON "batching_config" TO fulfillment_write;

-- fulfillment_ops_read backs the guard-only admin list (listBatchingConfigs),
-- mirroring the bank_composition_config read grant (T5b). The table's own RLS
-- policy is unscoped (USING(true)), so read visibility is gated purely by this
-- GRANT.
GRANT SELECT ON "batching_config" TO fulfillment_ops_read;
