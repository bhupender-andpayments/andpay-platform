-- CreateTable
CREATE TABLE "aggregator_projection" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregator_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aggregator_projection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aggregator_projection_tenant_id_aggregator_code_key" ON "aggregator_projection"("tenant_id", "aggregator_code");

-- aggregator_projection is an event-fed read-model from fct.identity.aggregator.v1
-- (T7), same posture as tenant_projection (20260723103031): no prog_ to gate
-- on, so FORCE RLS with a permissive policy in v1.
ALTER TABLE "aggregator_projection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "aggregator_projection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "aggregator_projection_v1" ON "aggregator_projection" USING (true) WITH CHECK (true);

-- GRANTs are explicit and per-table (established by 20260813100000): the
-- blanket "GRANT ... ON ALL TABLES IN SCHEMA tms" in 20260727000000 only
-- bound the tables that existed when it ran, and there is no ALTER DEFAULT
-- PRIVILEGES in this schema. tenant_projection's own migration granted no
-- per-table read role (it predates tms_read/tms_ops_read, and the later
-- 20260727000010 tightening left tenant_projection with no tms_read or
-- tms_ops_read grant at all), so this migration mirrors that exactly: only
-- tms_write gets a grant, no DELETE (the consumer only upserts).
GRANT SELECT, INSERT, UPDATE ON "aggregator_projection" TO tms_write;
