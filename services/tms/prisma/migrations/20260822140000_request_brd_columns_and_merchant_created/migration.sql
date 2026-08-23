-- BRD 5.1b alignment for the merchant surfaces, 22 Aug 2026.
--
-- FIVE BANK-FILE COLUMNS WERE PARSED AND THEN THROWN AWAY. The Annexure B
-- profile composed City/State/Pincode into the single ship_to_address string
-- and never kept the parts; Email ID and QR Type it did not read at all. The
-- BRD lists all five as merchant/request fields, so "do we store what the BRD
-- says" was answered no for them. These columns are that answer changing.
--
-- ship_to_address is deliberately NOT replaced: it is what the dispatch label
-- prints and what the print vendor workbook carries. The parts are additive
-- alongside it, never instead of it.
--
-- ALL NULLABLE, the same rule contact_name/mobile/branch_code follow: additive
-- to a BUILT-V1 table, so a NOT NULL would break every pre-existing row and
-- the ingest INSERT. Email ID and QR Type are Optional in the BRD and blank in
-- the real GSCB file, so they are never a row-level rejection. City/State/
-- Pincode stay covered by the existing mandatory registered_address check.
--
-- Nothing here reaches a fact. These are TMS-local snapshot columns, exactly
-- like contact_name and branch_code before them; widening the assignment fact
-- would be a fact-shape change and therefore its own decision.
ALTER TABLE "pending_row" ADD COLUMN "email" TEXT;
ALTER TABLE "pending_row" ADD COLUMN "city" TEXT;
ALTER TABLE "pending_row" ADD COLUMN "state" TEXT;
ALTER TABLE "pending_row" ADD COLUMN "pincode" TEXT;
ALTER TABLE "pending_row" ADD COLUMN "qr_type" TEXT;

ALTER TABLE "assignment" ADD COLUMN "email" TEXT;
ALTER TABLE "assignment" ADD COLUMN "city" TEXT;
ALTER TABLE "assignment" ADD COLUMN "state" TEXT;
ALTER TABLE "assignment" ADD COLUMN "pincode" TEXT;
ALTER TABLE "assignment" ADD COLUMN "qr_type" TEXT;

-- The merchants list had no created date to show at all: merchant_projection
-- carried updated_at only, so "when did we first see this merchant" was
-- unanswerable. Backfilled from updated_at, which for a merchant nothing has
-- amended since ingest IS its first-seen instant, and is the closest honest
-- value for one that has been amended.
ALTER TABLE "merchant_projection" ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();
UPDATE "merchant_projection" SET "created_at" = "updated_at";

-- No GRANT needed: 20260808190000_merchant_projection_ops_read_grant grants
-- SELECT at TABLE level to tms_ops_read, which new columns inherit, and the
-- same role already holds SELECT on assignment and pending_row.
