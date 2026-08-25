-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "parent_tenant_id" UUID;

-- CreateIndex
CREATE INDEX "tenant_parent_tenant_id_idx" ON "tenant"("parent_tenant_id");

-- AddForeignKey
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_parent_tenant_id_fkey" FOREIGN KEY ("parent_tenant_id") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
