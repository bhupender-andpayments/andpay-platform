-- D-16 activation branch (12 Aug 2026 walkthrough), part 1 of 2.
--
-- Until now "activated" was a single scalar on the assignment row
-- (demand_state = 'activated' plus activated_at) and the only recorded activation
-- state was the final one. Two things were missing. There was no
-- REQUEST_SENT_TO_CWD, so the window between "we asked the CWD to activate this"
-- and "the CWD confirmed it" was invisible, which is exactly the window an
-- operator is chasing. And there was no history, so a device that was activated,
-- corrected, and re-activated left one timestamp and no account of itself.
--
-- This migration is the state. The trail table is modeled on fulfillment's
-- shpt_status_event, deliberately and line for line where it fits: append-only,
-- never mutated, a correction is a new forward event (107a), and the latest
-- status is denormalized back onto the aggregate (assignment.activation_status)
-- so the common read needs no aggregate. That table is the delivery branch's
-- trail; this one is the activation branch's, and D-16 says the two branches are
-- independent and shaped alike.
--
-- What this migration deliberately does NOT do: emit a fact. A new event topic
-- comes only from the architecture corpus by decision, and it would also need
-- provisioning in infra/aws/lib/topics.ts and packages/bus/src/topics.ts, which
-- are applied out of band (S23). So REQUEST_SENT_TO_CWD is TMS-local state read
-- by the ops edge, and analytics still learns about ACTIVATED only through the
-- existing fct.tms.assignment.activated.v1. The activation fact for the request
-- leg is recorded as corpus-owed (PLAN.md section 7 item 4).

-- The denormalized LATEST activation status: NULL (no request has been sent),
-- 'REQUEST_SENT_TO_CWD', or 'ACTIVATED'. Nullable because it is additive to a
-- built table and because NULL is a real state here, not an unknown: most
-- assignments have never been asked of the CWD at all. Enum tokens in a plain
-- text column with a CHECK, following demand_state / case_status / origin on
-- this same table rather than introducing the schema's first Prisma enum.
ALTER TABLE "assignment" ADD COLUMN IF NOT EXISTS "activation_status" text;

ALTER TABLE "assignment" DROP CONSTRAINT IF EXISTS "assignment_activation_status_check";
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_activation_status_check"
  CHECK ("activation_status" IS NULL OR "activation_status" IN ('REQUEST_SENT_TO_CWD', 'ACTIVATED'));

-- The append-only trail. occurred_at is when the thing HAPPENED (the CWD's
-- activation instant, the moment the request went out); created_at is platform
-- time (S22), and the two are kept apart for the same reason shpt_status_event
-- keeps courier_timestamp apart from received_at: reported time is not our time.
--
-- status_source is an enum token naming WHICH door wrote the row
-- ('ops:mark-activated', 'ops:request-activation'), so the trail can be read
-- back without joining the audit ledger. actor_id is nullable because not every
-- writer is a human: the port-driven activateAssignment path has no operator
-- behind it, and a NULL there means "no operator", not "we lost it".
--
-- No secrets, no PII, no free text: ids, enum tokens and timestamps only (S4,
-- S7).
CREATE TABLE "assignment_activation_event" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "asgn_id"       UUID NOT NULL,
  "program_id"    UUID NOT NULL,
  "status"        TEXT NOT NULL,
  "occurred_at"   TIMESTAMPTZ(6) NOT NULL,
  "status_source" TEXT NOT NULL,
  "actor_id"      UUID,
  "trace_id"      TEXT NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "assignment_activation_event_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assignment_activation_event_status_check"
    CHECK ("status" IN ('REQUEST_SENT_TO_CWD', 'ACTIVATED'))
);

-- The trail is read one assignment at a time (the per-dispatch detail page) and
-- written once per transition, so asgn_id is the only access path that matters.
CREATE INDEX "assignment_activation_event_asgn_id_idx" ON "assignment_activation_event" ("asgn_id");

-- D-3 write plane, mirroring "assignment_scoped" from 20260723103031_tms_domain:
-- permissive USING so a write scope can read its own rows back, and a WITH CHECK
-- binding every INSERT to the app.program_id the caller entered. The program is
-- always resolved server-side from the target assignment row (D99), never from a
-- request body, so this CHECK is what makes that resolution load-bearing rather
-- than decorative.
ALTER TABLE "assignment_activation_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assignment_activation_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assignment_activation_event_scoped" ON "assignment_activation_event"
  USING (true)
  WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

-- D-1 tenant read: RESTRICTIVE and fail-closed on an unset or empty
-- app.program_ids, exactly like assignment_tenant_read
-- (20260727000000_tenant_read_rls_roles). A tenant may read the activation
-- history of its own programs and of nothing else.
CREATE POLICY "assignment_activation_event_tenant_read" ON "assignment_activation_event"
  AS RESTRICTIVE FOR SELECT TO tms_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));

-- The class-3 ops read, mirroring assignment_ops_read
-- (20260727010000_ops_portal_columns_roles): cross-tenant by construction, which
-- is what an ops operator's worklist is.
CREATE POLICY "assignment_activation_event_ops_read" ON "assignment_activation_event"
  FOR SELECT TO tms_ops_read USING (true);

-- GRANTs are explicit and per-table on purpose. The blanket
-- "GRANT ... ON ALL TABLES IN SCHEMA tms" in 20260727000000 bound the tables that
-- existed WHEN IT RAN and no others, and there is no ALTER DEFAULT PRIVILEGES in
-- this schema (deliberately: a new table should have to say who may read it).
GRANT SELECT ON "assignment_activation_event" TO tms_read, tms_ops_read;
GRANT SELECT, INSERT, UPDATE, DELETE ON "assignment_activation_event" TO tms_write;
