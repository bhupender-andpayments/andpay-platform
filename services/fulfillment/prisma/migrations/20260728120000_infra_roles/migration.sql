-- Spec 10d Task 5 (Fork B): the fulfillment INFRA roles, cross-program-by-design.
-- These are library scans that MUST NOT bind a single program (they run with no
-- app.program_id GUC), so they are NOT the per-context M-pred write role
-- (fulfillment_write); they are dedicated non-owner roles with the least
-- privilege each scan actually needs (ruling L1). No production daemon is built
-- here (ruling C2): the roles are created and harness-proven against the
-- EXISTING library functions (relayOnce, claimAndFireDueTimers) in
-- test/write_plane_c4.test.ts. Additive and reversible (S23): no DROP, no ALTER
-- of any existing policy, no ALTER DEFAULT PRIVILEGES, no new WITH CHECK policy.
--
-- Roles are NOLOGIN NOSUPERUSER NOINHERIT (no BYPASSRLS, never a table owner),
-- matching every existing application role. Created idempotently so a re-run is
-- safe.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fulfillment_relay') THEN
    CREATE ROLE fulfillment_relay NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fulfillment_engine') THEN
    CREATE ROLE fulfillment_engine NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

-- USAGE on the OWN schema ONLY: a cross-schema query under either role fails
-- with permission denied for schema <other> (the database-level C4 backstop).
GRANT USAGE ON SCHEMA fulfillment TO fulfillment_relay, fulfillment_engine;

-- fulfillment_relay: the outbox drain (relayOnce). outbox is WITH CHECK(true)
-- and not program-scoped, so the drain claims every context's unpublished row
-- with no program predicate. SELECT + UPDATE on outbox ONLY.
GRANT SELECT, UPDATE ON fulfillment.outbox TO fulfillment_relay;

-- fulfillment_engine: the D77 lease scan (claimAndFireDueTimers). It claims due
-- timers across ALL pools with no program filter and writes only the saga_*
-- tables (all WITH CHECK(true), M-role). Least-privilege, distinct from
-- fulfillment_relay (ruling L1): saga tables ONLY, never the outbox. The
-- per-instance domain effect (batch birth on program-scoped tables) is NOT run
-- under this role: it opens its own single-program transaction under
-- fulfillment_write with the instance's own program GUC.
GRANT SELECT, INSERT, UPDATE ON fulfillment.saga_instance, fulfillment.saga_step, fulfillment.saga_timer TO fulfillment_engine;
