-- Expand-contract (S23): the 6e authz_audit gains a tamper-evident hash-chain.
-- Additive nullable columns only; there is no genesis row. The chain root is
-- the GENESIS_PREV_HASH constant in @andpay/audit, so the first real append
-- is seq 1 with prev_hash = that constant. actor_channel persists the 10a
-- edge-slice provenance so the canonical hash payload round-trips through
-- storage exactly. NOT NULL enforcement is a deferred contract deploy once
-- every writer goes through the appender. The table stays append-only (no
-- updated_at).
ALTER TABLE "authz_audit" ADD COLUMN "seq" BIGINT,
ADD COLUMN "prev_hash" TEXT,
ADD COLUMN "entry_hash" TEXT,
ADD COLUMN "actor_channel" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "authz_audit_seq_key" ON "authz_audit"("seq");
