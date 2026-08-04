-- Phase 3 Task 5b: the admin write path for bank_composition_config (branding
-- + per-product image templates + logo, by (tenant_id, bank_code,
-- branch_code)). Additive/widening only (S23 expand-contract).

-- 1) logo_master_ref/logo_derivative_ref become nullable. A fresh row born
-- from a branding/template-only upsert (upsertBankCompositionConfig,
-- ops.ts) carries no logo yet; a logo upload (setBankLogo) sets
-- logo_master_ref and explicitly NULLs logo_derivative_ref (rasterization is
-- deferred, so the prior derivative is invalidated, never left pointing at a
-- stale master). Widening a NOT NULL to nullable is backward compatible: every
-- pre-existing row already carries a non-null value in both columns.
ALTER TABLE "bank_composition_config" ALTER COLUMN "logo_master_ref" DROP NOT NULL;
ALTER TABLE "bank_composition_config" ALTER COLUMN "logo_derivative_ref" DROP NOT NULL;

-- 2) fulfillment_ops_read gains SELECT on bank_composition_config, for the new
-- guard-only admin read (listBankCompositionConfigs, ops-read.ts). The table's
-- own RLS policy ("bank_composition_config_v1", USING (true) WITH CHECK (true))
-- is unscoped (applies to any role with the grant), so read visibility here is
-- gated purely by this GRANT, mirroring vndr's own fulfillment_ops_read grant.
GRANT SELECT ON "bank_composition_config" TO fulfillment_ops_read;
