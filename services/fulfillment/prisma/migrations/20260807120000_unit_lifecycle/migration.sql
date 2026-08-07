-- Unit lifecycle (Bhupender, 2026-08-07): a device must carry its own status
-- from intake through printing, dispatch, delivery, activation and damage.
--
-- Before this, unit.status was written ONCE at intake to 'IN_STOCK' and never
-- changed again: measured on the real 150-device CWD file, all 150 sat at
-- IN_STOCK forever. The RELATIONSHIPS were maintained (batch, shipment,
-- printed_for_merchant) but the status never advanced.
--
-- ADDITIVE ONLY (S23 expand-contract): one nullable column plus an index. No
-- existing column changes type, gains NOT NULL, or is dropped, so this is safe
-- to apply ahead of the code that writes it.

-- The assignment a unit was printed for. unit already links to merchant, batch
-- and shipment, but activation and damage both happen against an ASSIGNMENT,
-- and a merchant can hold several assignments over time (a replacement is a new
-- assignment for the same merchant), so merchant is too coarse to carry an
-- activation back to the right device. Nullable because stock exists before it
-- is paired to anything, and because every pre-existing row predates the link.
ALTER TABLE "unit" ADD COLUMN "asgn_id" UUID;

-- Backs the lookup the activation and damage consumers do (find the unit for
-- this assignment). Not UNIQUE: a re-print for the same assignment would
-- legitimately pair a second device, and turning that into a constraint
-- violation would fail the whole file rather than being adjudicated by ops.
CREATE INDEX "unit_asgn_id_idx" ON "unit"("asgn_id");
