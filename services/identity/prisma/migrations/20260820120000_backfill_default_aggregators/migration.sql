-- Backfill (spec 2026-08-20 section 3.3): tenants created BEFORE the
-- aggregator table gained the default-mint never received their default
-- aggregator. Idempotent: only tenants with no is_default row get one.
-- No outbox fact is emitted here (a migration cannot build an E4 envelope);
-- the TMS projection picks the row up on its first admin edit, and name
-- resolution for a tenant's own code falls back to tenant_projection anyway.
INSERT INTO "aggregator" (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
SELECT gen_random_uuid(), t.id, t.bank_reference_code, t.display_name, 'ACTIVE', true, now()
FROM "tenant" t
WHERE NOT EXISTS (
  SELECT 1 FROM "aggregator" a WHERE a.tenant_id = t.id AND a.is_default
)
ON CONFLICT (tenant_id, aggregator_code) DO UPDATE SET is_default = true;
