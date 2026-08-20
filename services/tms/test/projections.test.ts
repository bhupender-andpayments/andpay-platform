import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { projectMerchantFact, projectTenantFact, projectAggregatorFact } from '../src/projections.js'

const url =
  process.env.TMS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=tms'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE assignment, assignment_activation_event, pending_row, merchant_projection, tenant_projection, aggregator_projection, ingest_file, quarantine_row, outbox, inbox',
  )
})
afterAll(async () => { await db.$disconnect() })

describe('tms projections (T7, C4)', () => {
  it('projects the merchant fact into merchant_projection and dedupes on redelivery', async () => {
    const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
    const env = newEnvelope({
      type: 'fct.identity.merchant.v1', version: 1, subject: mrchId,
      dedupKey: 'evt-m|identity.merchant', traceId: 't',
      payload: { mrchId, displayName: 'Acme', legalName: 'Acme Pvt Ltd', mcc: '5814', status: 'ACTIVE' },
    })
    await projectMerchantFact(db, env)
    // Redelivery of the SAME event (same dedupKey) with a changed payload must be
    // skipped by onceWithin, so the stored value stays 'Acme'. This proves the
    // dedup, not just upsert convergence.
    const env2 = newEnvelope({
      type: 'fct.identity.merchant.v1', version: 1, subject: mrchId,
      dedupKey: 'evt-m|identity.merchant', traceId: 't',
      payload: { mrchId, displayName: 'Acme 2', legalName: 'Acme Pvt Ltd', mcc: '5814', status: 'ACTIVE' },
    })
    await projectMerchantFact(db, env2)
    const rows = await db.$queryRaw<{ display_name: string }[]>`SELECT display_name FROM merchant_projection WHERE id = ${toUuid(mrchId)}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.display_name).toBe('Acme')
  })

  it('projects the tenant fact into tenant_projection', async () => {
    const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
    const env = newEnvelope({
      type: 'fct.identity.tenant.v1', version: 1, subject: tnntId,
      dedupKey: 'evt-t|identity.tenant', traceId: 't',
      payload: { tnntId, displayName: 'HDFC Bank', bankReferenceCode: 'HDFC', status: 'ACTIVE' },
    })
    await projectTenantFact(db, env)
    const rows = await db.$queryRaw<{ bank_reference_code: string }[]>`SELECT bank_reference_code FROM tenant_projection WHERE id = ${toUuid(tnntId)}::uuid`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.bank_reference_code).toBe('HDFC')
  })

  it('projects the aggregator fact into aggregator_projection', async () => {
    const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
    const aggrId = fromUuid('aggr', toUuid(newId('aggr')))
    const env = newEnvelope({
      type: 'fct.identity.aggregator.v1', version: 1, subject: tnntId,
      dedupKey: 'evt-a|identity.aggregator', traceId: 't',
      payload: { aggrId, tnntId, aggregatorCode: 'VSC', displayName: 'VSC Bank', status: 'ACTIVE', isDefault: true },
    })
    await projectAggregatorFact(db, env)
    const rows = await db.$queryRaw<{ aggregator_code: string; display_name: string }[]>`
      SELECT aggregator_code, display_name FROM aggregator_projection
    `
    expect(rows).toEqual([{ aggregator_code: 'VSC', display_name: 'VSC Bank' }])
  })
})
