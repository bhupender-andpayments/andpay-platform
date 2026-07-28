-- Spec 10d Task 2: Identity write/read/relay roles. No new policy (the spec 05
-- policies already exist and are not scoped TO any role, so any non-owner role
-- is already subject to them). This migration only creates the roles and
-- grants the exact table/sequence set projectRowFact touches.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_write') THEN
    CREATE ROLE identity_write NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_read') THEN
    CREATE ROLE identity_read NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'identity_relay') THEN
    CREATE ROLE identity_relay NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA identity TO identity_write, identity_read, identity_relay;

-- write role: exactly the tables projectRowFact touches (tenant, merchant,
-- merchant_bank_ref, program, enrollment, outbox, inbox), the full identity
-- domain table set. No DELETE (projectRowFact never deletes a row).
GRANT SELECT, INSERT, UPDATE ON identity.tenant, identity.merchant, identity.merchant_bank_ref,
  identity.program, identity.enrollment, identity.outbox, identity.inbox TO identity_write;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA identity TO identity_write;

-- read role: dead until the class-1/2 identity read surface lands (D1
-- precedent), no grants beyond USAGE.

-- relay role (Fork B, Task 5): outbox drain only.
GRANT SELECT, UPDATE ON identity.outbox TO identity_relay;
