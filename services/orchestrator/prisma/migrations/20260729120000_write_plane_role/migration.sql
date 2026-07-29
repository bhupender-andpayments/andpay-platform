-- Spec 10d Task 7: orchestrator_write, a DEAD role (Fork D, check 7). The
-- orchestrator context has a Prisma project but no services/orchestrator/src;
-- the D77 engine internals are deferred by design. This role exists for
-- symmetry/completeness only, mirroring the 10c dead-role precedent: no
-- handler, no domain-table grants, no ALTER DEFAULT PRIVILEGES.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='orchestrator_write') THEN
    CREATE ROLE orchestrator_write NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA orchestrator TO orchestrator_write;
-- dead role: no table grants, no handler (services/orchestrator/src does not exist)
