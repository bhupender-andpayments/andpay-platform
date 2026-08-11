-- Per-dispatch group assignments (W-5). One bank row births up to two assignments:
-- a SOUNDBOX group and a COLLATERAL group. Existing rows are combined legacy
-- rows; they are stamped with their dominant dispatch group so the column can be NOT
-- NULL, and downstream contexts treat their own NULL dispatch group as legacy.
ALTER TABLE "assignment" ADD COLUMN "dispatch_group" TEXT;
UPDATE "assignment" SET "dispatch_group" = CASE WHEN "soundbox" THEN 'SOUNDBOX' ELSE 'COLLATERAL' END;
ALTER TABLE "assignment" ALTER COLUMN "dispatch_group" SET NOT NULL;
-- Idempotency widens from one-assignment-per-row to one-assignment-per-group.
--
-- Deviation from the task brief's literal SQL: assignment_source_event_id_key is
-- a plain UNIQUE INDEX (CREATE UNIQUE INDEX, migration 20260723103031_tms_domain
-- line 98), not a table CONSTRAINT, confirmed live against
-- pg_constraint (conrelid = 'tms.assignment'::regclass returns only
-- assignment_pkey). DROP CONSTRAINT would fail against an index with no
-- matching pg_constraint row, so this drops the index and replaces it with
-- another CREATE UNIQUE INDEX, matching this schema's own convention: every
-- other @unique/@@unique in tms (pending_row_correlation_id_key,
-- quarantine_row_file_id_row_no_key, damage_reason_code_key,
-- damage_reason_label_key) is a CREATE UNIQUE INDEX too, never an
-- ADD CONSTRAINT ... UNIQUE.
DROP INDEX "assignment_source_event_id_key";
CREATE UNIQUE INDEX "assignment_source_event_id_dispatch_group_key" ON "assignment"("source_event_id", "dispatch_group");
