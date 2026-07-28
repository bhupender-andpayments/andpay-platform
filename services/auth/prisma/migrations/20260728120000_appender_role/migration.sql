-- Spec 10d Task 5 (Fork B): the auth_appender role, the SOLE ordered appender to
-- the tamper-evident 6e authz_audit hash-chain (S15, D121). It is distinct from
-- the per-context write role (auth has no program-scoped tables; every auth
-- table is WITH CHECK(true)) because appendAuthzAudit is an INFRA writer that
-- drains authz.audit payloads emitted by EVERY context edge, not just Auth's own
-- surface. No production daemon is built here (ruling C2): the role is created
-- and harness-proven against the EXISTING consumeAuthzAudit in
-- test/write_plane_c4.test.ts.
--
-- C4: auth_appender is granted the AUTH schema ONLY. It NEVER reads a tms or
-- fulfillment table. The cross-program drain model (10c precedent) is: each
-- context's OWN relay (fulfillment_relay, tms_relay) drains its OWN schema's
-- outbox and hands the drained payload to consumeAuthzAudit, which appends to
-- auth.authz_audit. There is no cross-schema SELECT anywhere in this path.
--
-- Additive and reversible (S23): no DROP, no ALTER of any existing policy, no
-- ALTER DEFAULT PRIVILEGES. Role is NOLOGIN NOSUPERUSER NOINHERIT (no BYPASSRLS,
-- never a table owner), created idempotently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_appender') THEN
    CREATE ROLE auth_appender NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

-- USAGE on the OWN (auth) schema ONLY, the database-level C4 backstop.
GRANT USAGE ON SCHEMA auth TO auth_appender;

-- authz_audit: append-only, plus the head-read SELECT that computes prev_hash
-- and the next seq. SELECT + INSERT ONLY (never UPDATE/DELETE: the chain is
-- append-only, S15).
GRANT SELECT, INSERT ON auth.authz_audit TO auth_appender;

-- inbox: the onceWithin E6 dedup on the delivered payload.id. INSERT (the
-- ON CONFLICT DO NOTHING claim) plus SELECT for completeness.
GRANT SELECT, INSERT ON auth.inbox TO auth_appender;
