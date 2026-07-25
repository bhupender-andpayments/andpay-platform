-- spec 06a: additive recipient contact snapshot (BRD FR-01b bank-file columns,
-- FR-04 dispatch label). Nullable columns on the existing assignment and
-- pending_row tables; no RLS change, no index change, no new table. This is a
-- FULL-compatible additive extension (D120): the assignment fact fields are
-- optional, and ingest enforces them as mandatory per row at the application
-- layer. contact_name and mobile are entitled shipping-recipient PII (D104),
-- carried on the assignment snapshot only, redacted from every log line (S7).
ALTER TABLE "assignment" ADD COLUMN "contact_name" TEXT;
ALTER TABLE "assignment" ADD COLUMN "mobile" TEXT;

ALTER TABLE "pending_row" ADD COLUMN "contact_name" TEXT;
ALTER TABLE "pending_row" ADD COLUMN "mobile" TEXT;
