-- Expand-contract, additive (S23): a deterministic 06.A idempotency key on
-- class-6 credential creation, so an operator retry does not mint a second
-- secret for the same request (spec 04 Section 10). Nullable plus a unique
-- index (Postgres treats NULLs as distinct), so it is a safe additive change.
ALTER TABLE "vendor_credential" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "vendor_credential_idempotency_key_key" ON "vendor_credential"("idempotency_key");
