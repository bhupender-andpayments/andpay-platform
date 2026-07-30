-- Analytics domain bootstrap (handoff spec 11, the S19 analytics/reporting
-- rail). Hand-authored to match the tree's migration style and to carry the
-- role matrix, grants, and RLS policies inline (the migration IS the security
-- foundation checks 1/19/28 depend on). Additive and reversible (S23): create
-- only, no DROP, no ALTER of any existing object in any other schema, no ALTER
-- DEFAULT PRIVILEGES.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "analytics";

-- CreateTable
CREATE TABLE "raw_event" (
    "envelope_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "program_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "raw_event_pkey" PRIMARY KEY ("envelope_id")
);

-- CreateTable
CREATE TABLE "dispatch_row" (
    "dispatch_id" TEXT NOT NULL,
    "program_id" UUID NOT NULL,
    "bank_code" TEXT NOT NULL,
    "bank_display" TEXT NOT NULL,
    "branch" TEXT,
    "merchant_display" TEXT NOT NULL,
    "device_ids" TEXT[],
    "awb" TEXT,
    "shpt_id" TEXT,
    "dispatch_date" TIMESTAMPTZ(6),
    "courier_status" TEXT,
    "delivery_date" TIMESTAMPTZ(6),
    "activation_status" TEXT,
    "sim_activation_status" TEXT,
    "activation_date" TIMESTAMPTZ(6),
    "activation_failure_reason" TEXT,
    "pipeline_state" TEXT NOT NULL,
    "is_replacement" BOOLEAN NOT NULL DEFAULT false,
    "original_dispatch_id" TEXT,
    "damage_reason" TEXT,
    "replacement_dispatch_id" TEXT,
    "replacement_status" TEXT,
    "billable_flag" BOOLEAN NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "sent_to_vendor_at" TIMESTAMPTZ(6),
    "dispatched_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dispatch_row_pkey" PRIMARY KEY ("dispatch_id")
);

-- CreateTable
CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer","dedup_key")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "partition_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_watermark" (
    "topic" TEXT NOT NULL,
    "as_of" TIMESTAMPTZ(6) NOT NULL,
    "envelope_id" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analytics_watermark_pkey" PRIMARY KEY ("topic")
);

-- CreateIndex
CREATE INDEX "dispatch_row_program_id_idx" ON "dispatch_row"("program_id");

-- CreateIndex
CREATE INDEX "dispatch_row_shpt_id_idx" ON "dispatch_row"("shpt_id");

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "outbox"("published_at", "created_at");

-- The analytics context roles, NOLOGIN NOSUPERUSER NOINHERIT (no BYPASSRLS,
-- never a table owner), matching every existing application role. Created
-- idempotently so a re-run is safe.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analytics_read') THEN
    CREATE ROLE analytics_read NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analytics_write') THEN
    CREATE ROLE analytics_write NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'analytics_relay') THEN
    CREATE ROLE analytics_relay NOLOGIN NOSUPERUSER NOINHERIT;
  END IF;
END $$;

-- Least-privilege grants. USAGE on the OWN schema ONLY, so a cross-schema query
-- under any analytics role fails with permission denied for schema <other> (the
-- database-level C4 backstop). NO ALTER DEFAULT PRIVILEGES: every table a role
-- touches gets an EXPLICIT grant, so a future table without an explicit grant
-- fails closed under SET LOCAL ROLE (the 10b/10d landmine).
GRANT USAGE ON SCHEMA analytics TO analytics_read, analytics_write, analytics_relay;
-- analytics_read: SELECT on the MODELED layer only (the mediation layer's sole identity).
GRANT SELECT ON analytics.dispatch_row TO analytics_read;
-- analytics_write: the ingest/projection worker; writes every table it touches. NO DELETE on raw_event (append-only, check 5).
GRANT INSERT ON analytics.raw_event TO analytics_write;
GRANT SELECT ON analytics.raw_event TO analytics_write;                -- read-back for the deterministic rebuild
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.dispatch_row TO analytics_write;  -- DELETE for drop-and-rebuild
GRANT SELECT, INSERT ON analytics.inbox TO analytics_write;
GRANT SELECT, INSERT ON analytics.outbox TO analytics_write;           -- 6e read-decision enqueue
GRANT SELECT, INSERT, UPDATE ON analytics.analytics_watermark TO analytics_write;
-- analytics_relay: the E1 outbox drain (relayOnce), predicate-free.
GRANT SELECT, UPDATE ON analytics.outbox TO analytics_relay;

-- RLS on the program-scoped tables (FORCE so the non-owner read role is gated;
-- the write role writes cross-program under a permissive FOR ALL).
ALTER TABLE analytics.dispatch_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.dispatch_row FORCE ROW LEVEL SECURITY;
-- Permissive FOR ALL so analytics_write can INSERT/UPDATE/DELETE across programs
-- (the projection builder is program-agnostic; program_id is set server-side at
-- ingest from the fact's own progId). Restrictive policies below apply ONLY to
-- the roles they are scoped TO, so this does not widen analytics_read.
CREATE POLICY "dispatch_row_all" ON analytics.dispatch_row FOR ALL USING (true) WITH CHECK (true);
-- Q5 ruling: the SINGLE-role cross-tenant capability. RESTRICTIVE FOR SELECT TO
-- analytics_read. Fail-closed: unset cross_tenant is NULL so the branch is
-- false; unset program_ids makes = ANY(NULL) NULL so 0 rows. A mediation miss
-- that sets NEITHER yields 0 rows, never all.
CREATE POLICY "dispatch_row_analytics_read" ON analytics.dispatch_row
  AS RESTRICTIVE FOR SELECT TO analytics_read
  USING (
    current_setting('app.cross_tenant', true) = 'true'
    OR program_id = ANY (current_setting('app.program_ids', true)::uuid[])
  );
-- raw_event carries program_id only where the fact does; it is NOT a consumer
-- read surface (analytics_read has no SELECT on it), so RLS here is a backstop
-- on the write role only. Enable+force for defense in depth; permissive write.
ALTER TABLE analytics.raw_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.raw_event FORCE ROW LEVEL SECURITY;
CREATE POLICY "raw_event_all" ON analytics.raw_event FOR ALL USING (true) WITH CHECK (true);
