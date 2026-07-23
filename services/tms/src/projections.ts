import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import type { TmsDb } from './db.js'
import { CONSUMER, type Tx } from './internal.js'

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

export async function projectMerchantFact(db: TmsDb, env: Envelope<MerchantFactView>): Promise<void> {
  const p = env.payload
  const uuid = toUuid(p.mrchId)
  await db.$transaction(async (tx: Tx) => {
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
