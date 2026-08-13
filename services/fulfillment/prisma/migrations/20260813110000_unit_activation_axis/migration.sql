-- D-16 activation branch, the device side (T4.4, 13 Aug 2026).
--
-- unit.status was one monotonic spine ending IN_STOCK -> ALLOCATED -> PRINTED ->
-- DISPATCHED -> DELIVERED -> ACTIVATED, and that last rung is the bug D-16
-- names. Because ACTIVATED outranked DELIVERED, a device the CWD activated
-- before the courier's delivery update landed could never afterwards record its
-- delivery: the monotonic guard refuses to move a device backwards, correctly,
-- and the ladder had wrongly told it that delivery was backwards. The ladder is
-- also about to stop being able to assume the order at all, since removing the
-- delivered-gate on activation (T4.2) makes activation-before-delivery an
-- ordinary case rather than a race.
--
-- So activation leaves the spine. status keeps the DELIVERY axis, which is
-- genuinely ordered, and activation becomes its own nullable timestamp on the
-- same row. The two axes can now be read together without either overwriting
-- the other, which is the whole of D-16 expressed on one table.

-- The activation axis. A timestamp rather than a second status column because
-- the device side of activation has exactly one transition: it is activated or
-- it is not. REQUEST_SENT_TO_CWD is an ASSIGNMENT-level state (a request is sent
-- for a dispatch, not for a serial) and lives on assignment_activation_event in
-- TMS; putting a copy here would be a second answer to the same question.
--
-- Reported time, not platform time (S22): this is when the CWD activated the
-- device, carried on the activation fact.
ALTER TABLE "unit" ADD COLUMN IF NOT EXISTS "activated_at" timestamptz(6);

-- Rows already sitting on the retired rung.
--
-- activated_at is backfilled from updated_at, which for these rows IS the
-- activation write: the ACTIVATED transition was the last thing that touched
-- them, since nothing could advance past it.
--
-- status is moved to DELIVERED, and that carries ONE STATED ASSUMPTION rather
-- than a derivation: the only wired door to ACTIVATED is the ops edge, which
-- refused any assignment whose analytics row had no delivery date, so a device
-- that reached ACTIVATED had been delivered. The DevicePort path could in
-- principle have skipped that check, but it has no adapter wired in Phase 1
-- (R4). If that assumption is ever wrong for a row, the error is one rung of
-- delivery history, not a lost activation: the activation itself is preserved
-- exactly, in the new column.
--
-- The local dev database has ZERO unit rows in any status at the time of
-- writing, so this backfill is a production-shaped safety net rather than
-- something exercised here.
UPDATE "unit" SET "activated_at" = "updated_at" WHERE "status" = 'ACTIVATED' AND "activated_at" IS NULL;
UPDATE "unit" SET "status" = 'DELIVERED' WHERE "status" = 'ACTIVATED';

-- No GRANT and no policy change. activated_at is a new column on an existing
-- table, and Postgres table-level privileges cover columns added later, so the
-- fulfillment_write GRANT and the fulfillment_ops_read SELECT both already reach
-- it. unit is PLATFORM-ONLY (no program_id), so there is no scope predicate to
-- extend either.
