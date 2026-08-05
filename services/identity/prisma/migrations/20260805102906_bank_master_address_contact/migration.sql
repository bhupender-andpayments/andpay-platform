-- Phase 3 Task 7 (BRD Annexure D.1): extend the Bank Master (identity.tenant)
-- with the admin-owned address/contact fields.
--
-- ALL new columns are NULLABLE even though BRD D.1 marks most of them mandatory.
-- The ingest auto-mint (resolveTenant, src/project.ts) inserts a tenant row with
-- NONE of these fields set and must keep working unchanged, so the BRD D.1
-- mandatory/optional distinction is enforced in the admin-write application
-- layer (createBankMaster validates the mandatory ones), never as a DB NOT NULL
-- that would break the ingest INSERT (and would also fail this ALTER against any
-- pre-existing auto-minted rows, which have no address/contact).
--
-- bank_reference_code is untouched: it stays the immutable ingest resolver key
-- (editBankMaster never accepts or mutates it). No new grant or policy is needed:
-- identity_write already holds INSERT/UPDATE on identity.tenant (spec 10d Task 2)
-- and the tenant_v1 RLS policy is USING (true) WITH CHECK (true); column
-- privileges follow the existing table-level grant.
ALTER TABLE "tenant" ADD COLUMN "address1" TEXT;
ALTER TABLE "tenant" ADD COLUMN "address2" TEXT;
ALTER TABLE "tenant" ADD COLUMN "address3" TEXT;
ALTER TABLE "tenant" ADD COLUMN "city" TEXT;
ALTER TABLE "tenant" ADD COLUMN "district" TEXT;
ALTER TABLE "tenant" ADD COLUMN "country" TEXT;
ALTER TABLE "tenant" ADD COLUMN "pin" TEXT;
ALTER TABLE "tenant" ADD COLUMN "mobile" TEXT;
ALTER TABLE "tenant" ADD COLUMN "email" TEXT;
