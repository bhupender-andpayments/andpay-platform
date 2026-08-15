-- R-7 (16 Aug 2026, docs/plan/UAT_DECISIONS_2026-08-16.md): the per-bank
-- batching override tier, revising D-10 (which granted tenant and global tiers
-- only). BRD 5.3.3 evaluates the pending pool "for each bank"; this tier is
-- what makes that evaluable without re-graining the pool itself.
--
-- SHAPE, deliberately narrow: a bank tier row carries MIN LOT SIZE ONLY.
-- Max wait stays resolved at the pool tiers (exact / tenant / global), because
-- the max-wait timer is armed per POOL (one saga instance per batch_pool row)
-- and a per-bank timer would be a pool re-grain, not a config row. The CHECK
-- below makes that one-column rule a table invariant rather than a code
-- convention: a bank row's max_wait_seconds IS NULL, a pool row's IS NOT NULL,
-- so nothing can write a bank-tier wait ceiling that nothing would ever read.
--
-- Additive and expand-contract (S23): every existing row gets the '' sentinel
-- (the same technique as tenant_wire/program_wire and T5a's branch_code), the
-- unique key widens to the triple, and an unchanged table resolves exactly as
-- it did yesterday.

ALTER TABLE "batching_config"
  ADD COLUMN "bank_reference_code" TEXT NOT NULL DEFAULT '';

-- max_wait_seconds becomes nullable ONLY so bank rows can decline to carry it;
-- the paired CHECK keeps it mandatory on every pool-tier row.
ALTER TABLE "batching_config"
  ALTER COLUMN "max_wait_seconds" DROP NOT NULL;

-- One row per scope, now including the bank dimension. The old two-column
-- unique is replaced, not kept alongside: keeping it would forbid a pool row
-- and a bank row sharing (tenant, program), which is the whole point.
DROP INDEX "batching_config_tenant_wire_program_wire_key";
CREATE UNIQUE INDEX "batching_config_tenant_wire_program_wire_bank_reference_code_key"
  ON "batching_config"("tenant_wire", "program_wire", "bank_reference_code");

-- A bank override is meaningless outside a tenant (bank reference codes are
-- the tenant's member-bank codes), and the bank/pool split of max_wait is an
-- equivalence, not two independent rules.
ALTER TABLE "batching_config"
  ADD CONSTRAINT "batching_config_bank_tier_scope"
  CHECK ("bank_reference_code" = '' OR "tenant_wire" <> '');
ALTER TABLE "batching_config"
  ADD CONSTRAINT "batching_config_bank_tier_wait"
  CHECK (("bank_reference_code" = '') = ("max_wait_seconds" IS NOT NULL));

-- No new GRANTs: 20260805100000 granted table-level SELECT/INSERT/UPDATE/DELETE
-- to fulfillment_write and table-level SELECT to fulfillment_ops_read, and a
-- table-level grant covers columns added later (unlike the column-scoped unit
-- grant that broke GET /ops/devices when activated_at arrived).
