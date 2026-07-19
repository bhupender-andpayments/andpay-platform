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
CREATE INDEX "outbox_published_at_created_at_idx" ON "outbox"("published_at", "created_at");
