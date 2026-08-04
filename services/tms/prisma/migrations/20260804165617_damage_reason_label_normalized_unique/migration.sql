-- Fix-round 1 (review finding, Important): the plain case-sensitive unique
-- index on label let an admin create "battery issue" and "Battery Issue " as
-- two DISTINCT rows, since the ingest match (damage.ts) is
-- case/whitespace-insensitive (LOWER(TRIM(label))). Deactivating one of those
-- two rows then did nothing observable: the ingest match still found the
-- OTHER, still-active, normalized-identical row, so the reason still passed
-- validation. Replacing the plain unique with a unique index on the
-- NORMALIZED form closes this at the source: the collision can no longer be
-- CREATED, so a deactivation can no longer be silently defeated by one.

-- DropIndex
DROP INDEX "damage_reason_label_key";

-- The normalized-unique index. lower(trim(label)) is IMMUTABLE (both lower
-- and btrim/trim are marked immutable in Postgres for text), so it is a
-- valid expression index. Any two rows already in the table whose
-- lower(trim(label)) collide would make this CREATE UNIQUE INDEX fail
-- (existing-data safety net); none exist as of this migration (only the four
-- BRD-seeded rows, each normalized-distinct).
CREATE UNIQUE INDEX "damage_reason_label_normalized_key" ON "damage_reason" (lower(trim(label)));
