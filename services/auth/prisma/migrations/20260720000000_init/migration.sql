-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateTable
CREATE TABLE "internal_principal" (
    "id" UUID NOT NULL,
    "login_handle" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "internal_principal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_enrollment" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "factor" TEXT NOT NULL,
    "secret_ref" TEXT,
    "status" TEXT NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_credential" (
    "api_id" UUID NOT NULL,
    "peppered_hash" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "vndr_id" UUID NOT NULL,
    "work_queue" TEXT NOT NULL,
    "permission_set_ref" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "issued_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMPTZ(6),

    CONSTRAINT "vendor_credential_pkey" PRIMARY KEY ("api_id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "client_bind" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "denylist" (
    "entry" TEXT NOT NULL,
    "reason" TEXT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "denylist_pkey" PRIMARY KEY ("entry")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authz_audit" (
    "id" UUID NOT NULL,
    "principal_id" TEXT NOT NULL,
    "cls" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "resource_ids" TEXT[],
    "outcome" TEXT NOT NULL,
    "reason_code" TEXT,
    "acr" TEXT,
    "auth_time" TIMESTAMPTZ(6),
    "asserter_svid" TEXT,
    "trace_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authz_audit_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "internal_principal_login_handle_key" ON "internal_principal"("login_handle");

-- CreateIndex
CREATE INDEX "mfa_enrollment_principal_id_idx" ON "mfa_enrollment"("principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_credential_peppered_hash_key" ON "vendor_credential"("peppered_hash");

-- CreateIndex
CREATE INDEX "vendor_credential_vndr_id_idx" ON "vendor_credential"("vndr_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "session_principal_id_idx" ON "session"("principal_id");

-- CreateIndex
CREATE INDEX "authz_audit_created_at_idx" ON "authz_audit"("created_at");

-- CreateIndex
CREATE INDEX "outbox_published_at_created_at_idx" ON "outbox"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "mfa_enrollment" ADD CONSTRAINT "mfa_enrollment_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "internal_principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FORCE RLS posture (S13, gate item 17 PARTIAL). RLS is enabled and FORCED on
-- every auth table with a permissive policy for now. Most of this schema is
-- platform-only (class-3 tables have no tenant scope, D121/4c), so no Program
-- predicate applies yet; a per-workload least-privilege role and Program-scoped
-- predicates arrive with Program-scoped data. Superusers bypass RLS, so the
-- posture bites once a non-superuser workload role connects. Recorded, not
-- silently skipped.
ALTER TABLE "internal_principal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "internal_principal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "internal_principal_platform" ON "internal_principal" USING (true) WITH CHECK (true);

ALTER TABLE "mfa_enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_enrollment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "mfa_enrollment_platform" ON "mfa_enrollment" USING (true) WITH CHECK (true);

ALTER TABLE "vendor_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vendor_credential" FORCE ROW LEVEL SECURITY;
CREATE POLICY "vendor_credential_platform" ON "vendor_credential" USING (true) WITH CHECK (true);

ALTER TABLE "refresh_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_token" FORCE ROW LEVEL SECURITY;
CREATE POLICY "refresh_token_platform" ON "refresh_token" USING (true) WITH CHECK (true);

ALTER TABLE "denylist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "denylist" FORCE ROW LEVEL SECURITY;
CREATE POLICY "denylist_platform" ON "denylist" USING (true) WITH CHECK (true);

ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
CREATE POLICY "session_platform" ON "session" USING (true) WITH CHECK (true);

ALTER TABLE "authz_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "authz_audit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "authz_audit_platform" ON "authz_audit" USING (true) WITH CHECK (true);

ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_platform" ON "outbox" USING (true) WITH CHECK (true);

ALTER TABLE "inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inbox_platform" ON "inbox" USING (true) WITH CHECK (true);

