-- CreateTable
CREATE TABLE "saga_instance" (
    "id" UUID NOT NULL,
    "flow_type" TEXT NOT NULL,
    "flow_version" INTEGER NOT NULL,
    "current_step" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saga_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saga_step" (
    "instance_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_class" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saga_step_pkey" PRIMARY KEY ("instance_id","name")
);

-- CreateTable
CREATE TABLE "saga_timer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instance_id" UUID NOT NULL,
    "fire_at" TIMESTAMPTZ(6) NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saga_timer_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "inbox" (
    "consumer" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("consumer","dedup_key")
);

-- CreateIndex
CREATE INDEX "saga_timer_status_fire_at_idx" ON "saga_timer"("status", "fire_at");

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "outbox"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "saga_step" ADD CONSTRAINT "saga_step_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "saga_instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saga_timer" ADD CONSTRAINT "saga_timer_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "saga_instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FORCE RLS posture (S13, gate item 17 PARTIAL). Recorded now: RLS is enabled and
-- FORCED on every orchestrator table. There is no Program-scoped data in this
-- build, so the policy is permissive; a per-workload least-privilege role and
-- Program-scoped predicates arrive when the engine touches Program-scoped data
-- (spec 9). Superusers bypass RLS, so the posture bites once a non-superuser
-- workload role connects. This is recorded, not silently skipped.
ALTER TABLE "saga_instance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_instance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saga_instance_platform" ON "saga_instance" USING (true) WITH CHECK (true);

ALTER TABLE "saga_step" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_step" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saga_step_platform" ON "saga_step" USING (true) WITH CHECK (true);

ALTER TABLE "saga_timer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saga_timer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saga_timer_platform" ON "saga_timer" USING (true) WITH CHECK (true);

ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_platform" ON "outbox" USING (true) WITH CHECK (true);

ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inbox_platform" ON "inbox" USING (true) WITH CHECK (true);
