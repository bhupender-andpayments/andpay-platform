-- Phase 3 Task 2 (BRD FR-11): the courier integration channel (WEBHOOK | BATCH)
-- on vndr. Additive, nullable, reversible (S23 expand-contract). Applies to
-- COURIER rows only; a MANUFACTURER/PRINT vndr leaves this null. No
-- credential of any kind lives here (S4, class-6 stays Auth-owned).
ALTER TABLE "vndr" ADD COLUMN IF NOT EXISTS "integration_mode" text;
