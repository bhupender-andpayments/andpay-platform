-- AlterTable
ALTER TABLE "batch" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'BATCHED';

-- RenameIndex
ALTER INDEX "batching_config_tenant_wire_program_wire_bank_reference_code_ke" RENAME TO "batching_config_tenant_wire_program_wire_bank_reference_cod_key";
