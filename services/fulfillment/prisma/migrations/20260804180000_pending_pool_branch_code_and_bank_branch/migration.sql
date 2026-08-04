-- Phase 3 Task 5a: thread the T4 branch code snapshot (fct.tms.assignment.v1,
-- D120 FULL-compat, optional on the wire) into fulfillment, and widen
-- bank_composition_config's key to include branch. Additive, reversible
-- (S23 expand-contract).

-- 1) pending_pool_entry gains a nullable branch_code snapshot column,
-- populated by projectDemandFact (pool.ts). A fact without branchCode (a
-- pre-T4 / legacy fact) leaves this null; no crash, no fact version bump.
ALTER TABLE "pending_pool_entry" ADD COLUMN IF NOT EXISTS "branch_code" TEXT;

-- 2) bank_composition_config gains branch_code, NEVER NULL: Postgres treats
-- NULLs as distinct in a unique index, so a nullable branch_code would let
-- duplicate bank-level-default rows through. The bank-level default row uses
-- the '' empty-string sentinel instead of NULL, closing that gap. The
-- DEFAULT '' backfills every pre-existing row (each pre-existing row is, by
-- definition, today's one bank-level-default row) as the sentinel with no
-- separate UPDATE needed.
ALTER TABLE "bank_composition_config" ADD COLUMN IF NOT EXISTS "branch_code" TEXT NOT NULL DEFAULT '';

-- 3) widen the uniqueness from (tenant_id, bank_code) to (tenant_id,
-- bank_code, branch_code). The old index enforced at most one row per
-- (tenant, bank) total; the new one enforces at most one row per (tenant,
-- bank, branch) INCLUDING at most one bank-level-default ('' sentinel) row
-- per (tenant, bank), which is exactly the invariant the resolver
-- (dispatch.ts bankConfigRefFor) depends on for its fallback.
DROP INDEX IF EXISTS "bank_composition_config_tenant_id_bank_code_key";
CREATE UNIQUE INDEX IF NOT EXISTS "bank_composition_config_tenant_id_bank_code_branch_code_key"
  ON "bank_composition_config"("tenant_id", "bank_code", "branch_code");
