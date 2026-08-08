-- GO-LIVE BLOCKER E-3 (H3, task P4-3): the non-superuser login role for the
-- tms context.
--
-- THE POSTURE THIS FIXES IS LIVE, NOT LATENT. Measured 2026-08-08: `andpay` is
-- the ONLY role in this cluster that can log in, and it is SUPERUSER with
-- BYPASSRLS. Every connection the platform makes is therefore a superuser
-- connection, which means **every RLS policy in the platform is bypassed right
-- now**. The policies are correct and thoroughly tested; nothing is enforcing
-- them in a running system.
--
-- NOINHERIT IS LOAD-BEARING, not a copy of the work-role idiom. The app pattern
-- is: connect as tms_app, then `SET LOCAL ROLE <work role>` for the work at
-- hand. With INHERIT this role would hold the UNION of every privilege below it
-- from the moment it connects, so a read path could write and a query that
-- forgot to enter a role would silently succeed with more power than it should
-- have. With NOINHERIT it holds NOTHING until it explicitly enters a role, so
-- that same forgetful query gets a permission denied. That is what makes the
-- repo's "enter the role FIRST" rule enforceable instead of advisory.
--
-- NO PASSWORD IS SET HERE, deliberately (S4: secrets never in code, config or
-- migrations). A LOGIN role with no password cannot authenticate, so this fails
-- CLOSED: creating it changes nothing until Bhupender sets a password out of
-- band and rewires TMS_DATABASE_URL. Until then the platform keeps
-- connecting as `andpay` exactly as before.
--
-- Membership is EXACTLY this context's work roles and nothing else. That is the
-- C4 boundary expressed in the database: tms_app cannot enter another
-- context's roles even if application code asked it to.
--
-- Additive only (S23): no DROP, no ALTER of an existing role, no table touched.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tms_app') THEN
    CREATE ROLE tms_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- CONNECT is not granted explicitly: PUBLIC holds it by default on this
-- database. If a deployment REVOKEs CONNECT from PUBLIC (a reasonable
-- hardening), each <ctx>_app needs an explicit GRANT CONNECT there.
GRANT tms_write, tms_read, tms_ops_read, tms_relay TO tms_app;
