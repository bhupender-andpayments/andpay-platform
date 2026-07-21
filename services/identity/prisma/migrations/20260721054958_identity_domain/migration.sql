-- CreateTable
CREATE TABLE "merchant" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "mcc" TEXT NOT NULL,
    "registered_address" TEXT NOT NULL,
    "activation_state" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_bank_ref" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "bank_merchant_reference" TEXT NOT NULL,
    "merchant_id" UUID NOT NULL,
    "vpa_hint" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_bank_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bank_reference_code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchant_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchant_bank_ref_tenant_id_bank_merchant_reference_key" ON "merchant_bank_ref"("tenant_id", "bank_merchant_reference");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_bank_reference_code_key" ON "tenant"("bank_reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "program_tenant_id_product_type_key" ON "program"("tenant_id", "product_type");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_program_id_merchant_id_key" ON "enrollment"("program_id", "merchant_id");

-- FORCE RLS posture (S13, gate item 17 PARTIAL), spec 05 section 9. RLS is
-- enabled and FORCED on every identity table under the staged per-workload
-- least-privilege role (the spec-02/03/04 DB-boundary precedent). Superusers
-- bypass RLS, so the write-gate bites once a non-superuser workload role
-- connects; the merchant_bank_ref UNIQUE (a constraint, not RLS) bites now.
--
-- merchant, merchant_bank_ref, tenant: tenant-scoped, permissive in v1. The
-- merchant-global tenant-portal relationship-gated read predicate is deferred to
-- the class-2 read surface (step 9). Reads must stay open now so the
-- cross-Program merchant resolve can span the tenant's Programs.
ALTER TABLE "merchant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "merchant_v1" ON "merchant" USING (true) WITH CHECK (true);

ALTER TABLE "merchant_bank_ref" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_bank_ref" FORCE ROW LEVEL SECURITY;
CREATE POLICY "merchant_bank_ref_v1" ON "merchant_bank_ref" USING (true) WITH CHECK (true);

ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_v1" ON "tenant" USING (true) WITH CHECK (true);

-- program and enrollment are Program-scoped (07.A class 1). Reads open in v1;
-- writes are gated on the SET LOCAL app.program_id context (07.B), so a write
-- can only land for the Program the workload has entered. program_id for the
-- program table is its own id.
ALTER TABLE "program" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "program" FORCE ROW LEVEL SECURITY;
CREATE POLICY "program_scoped" ON "program" USING (true) WITH CHECK (id = current_setting('app.program_id', true)::uuid);

ALTER TABLE "enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "enrollment_scoped" ON "enrollment" USING (true) WITH CHECK (program_id = current_setting('app.program_id', true)::uuid);

-- outbox and inbox carry no tenant-visible rows; FORCE RLS is applied for a
-- uniform posture (spec 05 section 9, "FORCE RLS on all tables"), permissive.
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_platform" ON "outbox" USING (true) WITH CHECK (true);

ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inbox_platform" ON "inbox" USING (true) WITH CHECK (true);
