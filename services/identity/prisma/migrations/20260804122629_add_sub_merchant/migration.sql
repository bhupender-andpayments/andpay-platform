-- CreateTable
CREATE TABLE "sub_merchant" (
    "id" UUID NOT NULL,
    "merchant_id" UUID NOT NULL,
    "registered_address" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sub_merchant_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "sub_merchant" ADD CONSTRAINT "sub_merchant_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FORCE RLS posture (S13, spec 05 section 9 precedent, mirrored from the
-- merchant table): permissive in v1, no cascade/suspend surface exists yet so
-- there is nothing to gate on. The write-gate bites once a non-superuser
-- workload role connects (the merchant precedent).
ALTER TABLE "sub_merchant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sub_merchant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sub_merchant_v1" ON "sub_merchant" USING (true) WITH CHECK (true);

-- Extend identity_write (spec 10d Task 2 mechanism) to cover the new table.
-- projectRowFact only ever inserts the one default sub_merchant per merchant;
-- no UPDATE/DELETE needed yet, matching how merchant itself started narrower
-- than its eventual grant (kept consistent here with SELECT, INSERT only).
GRANT SELECT, INSERT ON identity.sub_merchant TO identity_write;
