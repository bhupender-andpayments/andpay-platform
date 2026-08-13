-- D-22 and Workflow C step 1 (T6.4, 13 Aug 2026).
--
-- TWO changes, and they belong together because neither is much use alone.

-- 1. The `others` damage reason (D-22).
--
-- The master seeds four specific reasons and nothing else, so a bank reporting
-- damage that is none of those four has no row it can name: its file quarantines
-- with invalid_damage_reason, and the operator's only route forward is to invent
-- a reason in the master. D-22 adds the escape hatch.
--
-- A MIGRATION AND NOT A DATA PATCH, deliberately. damage_reason is PRESERVED
-- master data (vitest.global-teardown.ts keeps it through every gate), so a row
-- inserted by hand survives locally and then does not exist at all in a freshly
-- provisioned environment. The four existing reasons are seeded by migration
-- 20260804163403 for exactly this reason; this follows it.
--
-- ON CONFLICT DO NOTHING, matching that migration, so a replay is idempotent.
-- The label is what the ingest matches on (case- and whitespace-insensitive);
-- `code` is the stable admin-facing identifier.
INSERT INTO "damage_reason" (code, label, active, updated_at) VALUES
  ('others', 'others', true, now())
ON CONFLICT DO NOTHING;

-- 2. The OPS-side remarks column.
--
-- `bank_remarks` holds what the BANK wrote on the damage row. There was nowhere
-- for an operator to write anything back, which is what makes 'others' only half
-- a feature: a reason of "others" with no note is a case nobody can work. This
-- is the AND-side of Workflow C step 1, and it is a SECOND column rather than an
-- edit of the first because they are different people's words and an audit that
-- cannot tell them apart is not worth keeping.
--
-- Nullable, additive to a built table. Free operator text, so it lives on the
-- domain row and never on a fact or an audit record (S7/DD1), the same posture
-- as batch.trigger_note and pending_pool_entry.hold_reason.
--
-- No GRANT is needed: Postgres table-level privileges cover columns added later,
-- and `assignment` already carries SELECT to tms_read/tms_ops_read and the full
-- set to tms_write.
ALTER TABLE "assignment" ADD COLUMN IF NOT EXISTS "ops_remarks" text;
