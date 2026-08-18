-- Backfill the batch lifecycle column for batches that already existed when it
-- was added. Until 18 Aug 2026 a batch was sent to the print vendor
-- automatically the moment it formed, so every historical batch whose entries
-- have left QR_GENERATED is already at the vendor or beyond. Leaving those rows
-- on the 'BATCHED' default would tell an operator they still need sending.
--
-- The new send-to-vendor and close actions are the only writers from here on.
-- CLOSED is never assigned here: closing is a deliberate operator act with a
-- settlement gate, and nobody has performed it for these rows.
UPDATE "batch" b
SET status = 'SENT_TO_PRINT_VENDOR'
WHERE b.status = 'BATCHED'
  AND EXISTS (
    SELECT 1
    FROM "pending_pool_entry" p
    WHERE p.batch = b.id
      AND p.dispatch_state IN ('SENT_TO_VENDOR', 'DISPATCHED_BY_VENDOR')
  );
