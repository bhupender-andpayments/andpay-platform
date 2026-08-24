-- DAMAGE.md (21 Aug 2026): the damage case's own append-only trail, the tms
-- sibling of fulfillment's three status trails.
--
-- A case is a ticket about a complaint, not a device or dispatch status: it has
-- its own lifecycle (Open, In-Progress, Closed, and now Cancelled) and its own
-- clock. "When was this complaint opened, when did work actually start, how long
-- did it take to resolve" is a question only the case can answer, and nothing
-- could answer it: the row carried case_status plus one updated_at that every
-- later write overwrote.
--
-- Modeled on assignment_activation_event (20260813100000), which this schema
-- built and which the fulfillment trails were in turn cloned from. Additive,
-- new table only (S23 expand-contract).

-- CreateTable
CREATE TABLE "damage_case_status_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asgn_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status_source" TEXT NOT NULL,
    "actor_id" UUID,
    "remarks" TEXT,
    "trace_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "damage_case_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "damage_case_status_event_asgn_id_idx" ON "damage_case_status_event"("asgn_id");

-- The write gate: program_id must match the bound scope, which is always
-- resolved server-side from the target assignment (D99) and never from a request
-- body.
ALTER TABLE "damage_case_status_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "damage_case_status_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "damage_case_status_event_scoped" ON "damage_case_status_event"
  USING (true)
  WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

-- D-1 tenant read: RESTRICTIVE and fail-closed on an unset or empty
-- app.program_ids. A tenant may read its own programs' case history and nothing
-- else.
CREATE POLICY "damage_case_status_event_tenant_read" ON "damage_case_status_event"
  AS RESTRICTIVE FOR SELECT TO tms_read
  USING (program_id = ANY (current_setting('app.program_ids', true)::uuid[]));

-- The class-3 ops read: cross-tenant by construction, which is what an ops
-- operator's worklist is.
CREATE POLICY "damage_case_status_event_ops_read" ON "damage_case_status_event"
  FOR SELECT TO tms_ops_read USING (true);

-- GRANTS ARE NOT OPTIONAL ALONGSIDE THE POLICIES ABOVE, and that is worth
-- stating because it was got wrong once this week: the first status-trail
-- migration created ops-read POLICIES on two fulfillment tables and no GRANT,
-- and a policy without a grant is still "permission denied" (it decides WHICH
-- ROWS a role may see, not whether it may look at the table). Both are required.
-- The blanket grant in 20260727000000 bound the tables existing when it ran, and
-- there is no ALTER DEFAULT PRIVILEGES here on purpose: a new table should have
-- to say who may read it.
GRANT SELECT ON "damage_case_status_event" TO tms_read, tms_ops_read;
GRANT SELECT, INSERT ON "damage_case_status_event" TO tms_write;

-- Backfill: every case that already exists gets one synthetic event carrying its
-- CURRENT status, so an existing complaint shows its present position rather
-- than an empty trail. occurred_at is the row's updated_at, the only instant
-- available; marked source='backfill' so it is never mistaken for a real
-- transition.
INSERT INTO "damage_case_status_event" (asgn_id, program_id, status, occurred_at, status_source, trace_id)
  SELECT id, program_id, case_status, updated_at, 'backfill', 'backfill'
  FROM "assignment"
  WHERE case_status IS NOT NULL;
