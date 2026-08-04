-- Phase 3 Task 4: additive Branch Code snapshot (BRD 5.1b mandatory bank-file
-- column). Nullable columns on the existing assignment and pending_row tables;
-- no RLS change, no index change, no new table. This is a FULL-compatible
-- additive extension (D120): the assignment fact field is optional, and ingest
-- enforces it as mandatory per row at the application layer. branch_code is
-- TMS-local snapshot data, not an identity key (the tenant already keys on
-- bank_reference_code); it feeds analytics dispatch_row.branch via the
-- assignment fact. Mirrors the spec 06a contact_name/mobile additive columns.
ALTER TABLE "assignment" ADD COLUMN "branch_code" TEXT;

ALTER TABLE "pending_row" ADD COLUMN "branch_code" TEXT;
