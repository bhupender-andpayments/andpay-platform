-- Spec 12 Task 1: the mfa_enrollment write-path. Two additive, reversible,
-- expand-contract changes (S23). (1) enrolled_by_actor records the class-3
-- admin who seeded the enrollment (the admin-seed model, spec 12 field 2).
-- (2) the auth_write grant: the 10d write-plane migration explicitly withheld
-- a grant on mfa_enrollment ("no live write path this spec"); this slice adds
-- the first live write path, so without this grant the enroll write 403s under
-- SET LOCAL ROLE auth_write (there is no ALTER DEFAULT PRIVILEGES, the 10d
-- landmine). M-role only: auth has zero program-scoped tables.
ALTER TABLE "auth"."mfa_enrollment" ADD COLUMN "enrolled_by_actor" UUID;
UPDATE "auth"."mfa_enrollment" SET "enrolled_by_actor" = '00000000-0000-0000-0000-000000000000' WHERE "enrolled_by_actor" IS NULL;
ALTER TABLE "auth"."mfa_enrollment" ALTER COLUMN "enrolled_by_actor" SET NOT NULL;

GRANT SELECT, INSERT, UPDATE ON "auth"."mfa_enrollment" TO auth_write;
