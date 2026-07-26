-- AlterTable: the courier lookup key (D5). Nullable so non-courier vendors stay
-- NULL; Postgres UNIQUE permits many NULLs, so only real codes collide.
ALTER TABLE "vndr" ADD COLUMN "courier_code" TEXT;
CREATE UNIQUE INDEX "vndr_courier_code_key" ON "vndr"("courier_code");

-- AlterTable: carrier-status denormalization onto the shpt_ owner (T2, D106c).
-- Both nullable: every shpt born by spec 08 predates them.
ALTER TABLE "shpt" ADD COLUMN "status_at" TIMESTAMPTZ(6);
ALTER TABLE "shpt" ADD COLUMN "status_source" TEXT;

-- CreateTable: the append-only carrier-status trail (BRD FR-06). Never mutated;
-- a correction is a new forward event. No updated_at by design.
CREATE TABLE "shpt_status_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shpt_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "courier_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "status_source" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trace_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shpt_status_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "shpt_status_event_shpt_id_idx" ON "shpt_status_event"("shpt_id");

-- CreateTable: courier-channel quarantine (103d), a SIBLING of intake_exception
-- (D7). PERMISSIVE and carries NO program_id: an unknown AWB resolves to no
-- shpt_, hence to no Program, exactly the spec-06 Q1 pre-resolution posture.
-- file_id and row_ref are nullable because the webhook channel has neither.
CREATE TABLE "courier_status_exception" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "vndr_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "subject_ref" TEXT NOT NULL,
    "file_id" TEXT,
    "row_ref" TEXT,
    "reason_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courier_status_exception_pkey" PRIMARY KEY ("id")
);

-- RLS. shpt_status_event is PROGRAM-SCOPED (07.A class 1); the exception table
-- is platform/pre-resolution permissive. FORCE RLS on both.
ALTER TABLE "shpt_status_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shpt_status_event" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shpt_status_event_scoped" ON "shpt_status_event"
  USING (true)
  WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "courier_status_exception" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courier_status_exception" FORCE ROW LEVEL SECURITY;
CREATE POLICY "courier_status_exception_v1" ON "courier_status_exception" USING (true) WITH CHECK (true);
