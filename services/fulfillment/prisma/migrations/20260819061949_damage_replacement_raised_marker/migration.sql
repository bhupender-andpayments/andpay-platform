-- AlterTable
ALTER TABLE "pending_pool_entry" ADD COLUMN     "replacement_raised" BOOLEAN NOT NULL DEFAULT false;

-- RenameIndex
ALTER INDEX "batching_config_tenant_wire_program_wire_bank_reference_code_ke" RENAME TO "batching_config_tenant_wire_program_wire_bank_reference_cod_key";
