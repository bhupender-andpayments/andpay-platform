-- Ops can CLOSE a held row, and a closed row is distinguishable from a cured one.
--
-- WHY. D-8 (12 Aug 2026) grants the operator exactly TWO actions on a review
-- queue record: "Close" (it was a genuine duplicate, e.g. the bank typo'd
-- Soundbox=Yes, so the record is closed and removed from the queue, retained in
-- archive) and "Cure and reprocess". Only the second existed:
-- resolveQuarantineRow ALWAYS re-drives the ingest with a corrected row, so
-- there was no way to retire a row without ingesting something, and an operator
-- faced with a genuine duplicate had to either invent a correction or leave the
-- row in the queue forever. D-8's target state is an EMPTY queue, so a row that
-- cannot be retired is a row that makes the queue permanently lie.
--
-- WHAT THIS COLUMN IS. WHICH of the two actions retired the row. It is not a
-- second "is it resolved" flag: resolved_at already answers that and keeps
-- meaning exactly what it meant. This says whether the resolution re-drove an
-- ingest ('cured') or archived the row untouched ('closed'), which the queue
-- must be able to tell apart. Closing a real order and curing one are different
-- operational claims, and the archive is what a later audit reads.
--
-- Nullable, and it stays nullable. Rows resolved BEFORE this column existed were
-- all cured by construction, since curing was the only action, but they are NOT
-- backfilled: inventing a resolution for a row nobody recorded one for would put
-- a fabricated operator claim in the archive. NULL reads as "resolved before the
-- distinction existed", which is the truth. A text column with a CHECK rather
-- than a Postgres enum, matching how this schema spells its other closed
-- vocabularies (see case_status), so adding a value later needs no type surgery.
--
-- NO GRANT IS NEEDED, checked rather than assumed. This schema has no ALTER
-- DEFAULT PRIVILEGES, so a newly READ table needs its own grant, but a new
-- COLUMN on an already-granted table does not: every grant reaching
-- quarantine_row is TABLE-level (tms_write from 20260727000100, tms_ops_read
-- from the spec-10c ops-read migration).
-- Additive only (S23 expand-contract): one nullable column plus its CHECK, no
-- DROP, no ALTER of an existing column, no RLS change, no money surface.
ALTER TABLE "quarantine_row" ADD COLUMN IF NOT EXISTS "resolution" text;

ALTER TABLE "quarantine_row" DROP CONSTRAINT IF EXISTS "quarantine_row_resolution_check";
ALTER TABLE "quarantine_row"
  ADD CONSTRAINT "quarantine_row_resolution_check"
  CHECK ("resolution" IS NULL OR "resolution" IN ('cured', 'closed'));
