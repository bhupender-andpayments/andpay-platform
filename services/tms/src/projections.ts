import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { TmsDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'
import { enterWriteRole } from './write-context.js'

// The consumer views of the identity facts (T7). Declared locally, never
// imported from the identity service (C4). Drift is caught by the wire schema
// (D120) and the root round-trip test.
interface MerchantFactView {
  mrchId: string
  displayName: string
  legalName: string
  mcc: string
  status: string
}
interface TenantFactView {
  tnntId: string
  displayName: string
  bankReferenceCode: string
  status: string // part of the consumed fact; not projected in v1 (the bank snapshot needs only name + bankReferenceCode)
}
interface AggregatorFactView {
  aggrId: string
  tnntId: string
  aggregatorCode: string
  displayName: string
  status: string
  isDefault: boolean
}

export async function projectMerchantFact(db: TmsDb, env: Envelope<MerchantFactView>): Promise<void> {
  const p = env.payload
  const uuid = toUuid(p.mrchId)
  await db.$transaction(async (tx: Tx) => {
    // M-role only (spec 10d Task 3): no program-scoped write in this body.
    await enterWriteRole(tx, 'tms_write')
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      await tx.$executeRaw`
        INSERT INTO merchant_projection (id, display_name, legal_name, mcc, status, updated_at)
        VALUES (${uuid}::uuid, ${p.displayName}, ${p.legalName}, ${p.mcc}, ${p.status}, now())
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          legal_name = EXCLUDED.legal_name,
          mcc = EXCLUDED.mcc,
          status = EXCLUDED.status,
          updated_at = now()
      `
    })
  })
}

export async function projectTenantFact(db: TmsDb, env: Envelope<TenantFactView>): Promise<void> {
  const p = env.payload
  const uuid = toUuid(p.tnntId)
  await db.$transaction(async (tx: Tx) => {
    // M-role only (spec 10d Task 3): no program-scoped write in this body.
    await enterWriteRole(tx, 'tms_write')
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      await tx.$executeRaw`
        INSERT INTO tenant_projection (id, display_name, bank_reference_code, updated_at)
        VALUES (${uuid}::uuid, ${p.displayName}, ${p.bankReferenceCode}, now())
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          bank_reference_code = EXCLUDED.bank_reference_code,
          updated_at = now()
      `
    })
  })
}

export async function projectAggregatorFact(db: TmsDb, env: Envelope<AggregatorFactView>): Promise<void> {
  const p = env.payload
  const uuid = toUuid(p.aggrId)
  const tenantUuid = toUuid(p.tnntId)
  await db.$transaction(async (tx: Tx) => {
    // M-role only (spec 10d Task 3): no program-scoped write in this body.
    await enterWriteRole(tx, 'tms_write')
    await onceWithin(tx, CONSUMER, env.dedupKey, async () => {
      await tx.$executeRaw`
        INSERT INTO aggregator_projection (id, tenant_id, aggregator_code, display_name, status, is_default, updated_at)
        VALUES (${uuid}::uuid, ${tenantUuid}::uuid, ${p.aggregatorCode}, ${p.displayName}, ${p.status}, ${p.isDefault}, now())
        ON CONFLICT (id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          aggregator_code = EXCLUDED.aggregator_code,
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          is_default = EXCLUDED.is_default,
          updated_at = now()
      `
    })
  })
}
