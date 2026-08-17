-- The ops Add-merchant path (BRD 5.1, the bank-file field table): extend the
-- canonical merchant with the contact and six-part address block the dialog
-- collects. Item 1 of docs/plan/CORPUS_SUBMISSION_2026-08-17_MERCHANT_CREATE.md,
-- submitted and not yet ratified.
--
-- ALL new columns are NULLABLE, for exactly the reason the Bank Master block
-- above them is (20260805102906_bank_master_address_contact): the ingest path
-- (projectRowFact, src/project.ts) inserts a merchant with NONE of these set and
-- must keep working unchanged, so the BRD's mandatory/optional distinction is
-- enforced in the admin-write application layer (createMerchant validates the
-- mandatory ones), never as a DB NOT NULL that would both break the ingest
-- INSERT and fail this ALTER against every pre-existing ingested row.
--
-- No VPA column, deliberately. docs/plan/TASKLIST_2026-08-08.md item C-1 refused
-- a VPA column and the "one merchant per VPA" framing, because D1 is an INTERIM
-- key with a re-key migration expected. The VPA continues to live where ingest
-- already puts it: as merchant_bank_ref.vpa_hint, and as the input to the
-- bank_merchant_reference derived by @andpay/merchant-ref. Uniqueness therefore
-- stays per-bank, at the existing UNIQUE(tenant_id, bank_merchant_reference),
-- which is what that constraint already says.
--
-- No new grant or policy: identity_write already holds INSERT/UPDATE on
-- identity.merchant (20260728100000_write_plane_roles) at table level, so column
-- privileges follow, and the merchant RLS policy is unchanged by adding columns.
ALTER TABLE "merchant" ADD COLUMN     "address2" TEXT,
ADD COLUMN     "address3" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "state" TEXT;
