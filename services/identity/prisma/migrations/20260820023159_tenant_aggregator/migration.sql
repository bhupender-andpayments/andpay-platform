/*
  Warnings:

  - You are about to drop the column `parent_tenant_id` on the `tenant` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "tenant" DROP CONSTRAINT "tenant_parent_tenant_id_fkey";

-- DropIndex
DROP INDEX "tenant_parent_tenant_id_idx";

-- AlterTable
ALTER TABLE "tenant" DROP COLUMN "parent_tenant_id";

-- CreateTable
CREATE TABLE "aggregator" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregator_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "code_locked_at" TIMESTAMPTZ(6),
    "address1" TEXT,
    "address2" TEXT,
    "address3" TEXT,
    "city" TEXT,
    "district" TEXT,
    "country" TEXT,
    "pin" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aggregator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aggregator_tenant_id_idx" ON "aggregator"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "aggregator_tenant_id_aggregator_code_key" ON "aggregator"("tenant_id", "aggregator_code");

-- AddForeignKey
ALTER TABLE "aggregator" ADD CONSTRAINT "aggregator_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One default aggregator per tenant (backstop; the domain layer enforces).
CREATE UNIQUE INDEX "aggregator_one_default_per_tenant" ON "aggregator" ("tenant_id") WHERE "is_default";

-- Uniform posture: FORCE RLS, permissive v1 policy (same as tenant_v1).
ALTER TABLE "aggregator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "aggregator" FORCE ROW LEVEL SECURITY;
CREATE POLICY "aggregator_v1" ON "aggregator" USING (true) WITH CHECK (true);

-- identity_write owns the table like the rest of the domain set. No DELETE.
GRANT SELECT, INSERT, UPDATE ON identity.aggregator TO identity_write;
