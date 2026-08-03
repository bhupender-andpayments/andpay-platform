-- Fast-follow (SIM No capture, R2 duplicate detection): a non-unique index on
-- unit.sim_no backing the intake-time duplicate-ICCID lookup. NOT a UNIQUE
-- constraint: the BRD treats a duplicate ICCID as a flag-for-review case
-- (windowed detection), never an all-time uniqueness assertion, so a legitimate
-- SIM re-use is adjudicated by ops rather than rejected by a constraint (which
-- would also become a whole-file E1 rollback). Additive, reversible.
CREATE INDEX IF NOT EXISTS "unit_sim_no_idx" ON "unit"("sim_no");
