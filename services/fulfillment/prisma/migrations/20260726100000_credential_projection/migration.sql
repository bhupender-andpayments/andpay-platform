-- CreateTable: the Fulfillment-side (5c verifier plane) local copy of the
-- class-6 credential projection, fed by Auth's auth-config channel
-- (cfg.auth.credential.v1, Task 4). This is the LOCAL lookup the HTTP edge
-- (later tasks) resolves an apsk_ secret against with ZERO call to Auth
-- (5c/5e). peppered_hash is verification material, not a secret: it is
-- useless without the runtime-injected pepper. IDs, enums, and the peppered
-- hash ONLY, never a raw secret or PII (S7/S4). PLATFORM-ONLY, permissive
-- FORCE RLS in v1 (matches vndr_v1/unit_v1).
CREATE TABLE "credential_projection" (
    "api_id" UUID NOT NULL,
    "peppered_hash" TEXT NOT NULL,
    "vndr_id" UUID NOT NULL,
    "work_queue" TEXT NOT NULL,
    "permission_set_ref" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_projection_pkey" PRIMARY KEY ("api_id")
);

-- CreateIndex: the resolve-side lookup key (5c: one HMAC, one unique-index hit).
CREATE UNIQUE INDEX "credential_projection_peppered_hash_key" ON "credential_projection"("peppered_hash");

-- RLS. PLATFORM-ONLY verifier-plane data (no Program scope). FORCE RLS
-- permissive in v1, matching the repo convention for platform tables.
ALTER TABLE "credential_projection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credential_projection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credential_projection_v1" ON "credential_projection" USING (true) WITH CHECK (true);
