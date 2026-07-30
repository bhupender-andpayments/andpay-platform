import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { readReport } from '../src/mediation.js'
import type { ReadScope } from '../src/read-context.js'

// Task 6 rule-c: the Batching report has NO table. v1 reconstructs it from
// dispatch_row ONLY (never raw_event: analytics_read has no grant there), per
// bank: pool-size = count of RECEIVED (received, not yet advanced past
// RECEIVED) rows; oldest-record-age = now() - min(received_at) of those. The
// projected-trigger-date column is DEFERRED (rule c): v1's row shape carries
// NO projectedTriggerDate field.
const url =
  process.env.ANALYTICS_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=analytics'
const db = new PrismaClient({ datasourceUrl: url })

afterAll(async () => {
  await db.$disconnect()
})

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE analytics.dispatch_row, analytics.analytics_watermark CASCADE')
})

const DAY_MS = 24 * 60 * 60 * 1000

interface Row {
  dispatchId: string
  programId: string
  bankCode: string
  pipelineState: string
  receivedAt: Date
}

async function insertRow(r: Row): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dispatch_row
      (dispatch_id, program_id, bank_code, bank_display, merchant_display, device_ids,
       pipeline_state, billable_flag, received_at, updated_at)
    VALUES (${r.dispatchId}, ${r.programId}::uuid, ${r.bankCode}, ${r.bankCode + ' Bank'}, 'Acme',
            ARRAY['DEV1']::text[], ${r.pipelineState}, true, ${r.receivedAt}, now())`
}

describe('Task 6: the Batching report reconstruction (rule c)', () => {
  it('computes pool-size-per-bank and oldest-record-age from RECEIVED dispatch_row rows only, scoped to P1', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    const oldest = new Date(now.getTime() - 5 * DAY_MS)

    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'RECEIVED', receivedAt: oldest })
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'RECEIVED', receivedAt: now })
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'ICICI', pipelineState: 'RECEIVED', receivedAt: now })
    // already advanced past RECEIVED: excluded from the pool
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'POOLED', receivedAt: now })
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'DISPATCHED', receivedAt: now })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows, watermark } = await readReport(db, scope, 'batching', {})

    expect(rows).toHaveLength(2)
    const hdfc = rows.find((r) => r.bankCode === 'HDFC')!
    const icici = rows.find((r) => r.bankCode === 'ICICI')!
    expect(hdfc.poolSize).toBe(2)
    expect(icici.poolSize).toBe(1)
    expect(hdfc.oldestRecordAgeDays as number).toBeGreaterThan(4.9)
    expect(hdfc.oldestRecordAgeDays as number).toBeLessThan(5.1)
    expect(watermark).toBeDefined()
  })

  it('has NO projectedTriggerDate field in any row (rule c: deferred to a follow-up)', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'RECEIVED', receivedAt: now })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'batching', {})

    expect(rows).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(rows[0], 'projectedTriggerDate')).toBe(false)
  })

  it('per-scope isolation: a P1-own scope sees only P1 banks; crossTenant sees the union', async () => {
    const p1 = toUuid(newId('prog'))
    const p2 = toUuid(newId('prog'))
    const now = new Date()
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'RECEIVED', receivedAt: now })
    await insertRow({ dispatchId: newId('asgn'), programId: p2, bankCode: 'HDFC', pipelineState: 'RECEIVED', receivedAt: now })
    await insertRow({ dispatchId: newId('asgn'), programId: p2, bankCode: 'AXIS', pipelineState: 'RECEIVED', receivedAt: now })

    const p1Scope: ReadScope = { kind: 'own', programIds: [p1] }
    const crossScope: ReadScope = { kind: 'crossTenant' }

    const p1Rows = (await readReport(db, p1Scope, 'batching', {})).rows
    const crossRows = (await readReport(db, crossScope, 'batching', {})).rows

    expect(p1Rows).toHaveLength(1)
    expect(p1Rows[0]!.poolSize).toBe(1)

    const crossHdfc = crossRows.find((r) => r.bankCode === 'HDFC')!
    const crossAxis = crossRows.find((r) => r.bankCode === 'AXIS')!
    expect(crossHdfc.poolSize).toBe(2) // P1's 1 + P2's 1
    expect(crossAxis.poolSize).toBe(1)
  })

  it('bankCode filter narrows the per-bank aggregation', async () => {
    const p1 = toUuid(newId('prog'))
    const now = new Date()
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'HDFC', pipelineState: 'RECEIVED', receivedAt: now })
    await insertRow({ dispatchId: newId('asgn'), programId: p1, bankCode: 'ICICI', pipelineState: 'RECEIVED', receivedAt: now })

    const scope: ReadScope = { kind: 'own', programIds: [p1] }
    const { rows } = await readReport(db, scope, 'batching', { bankCode: 'ICICI' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.bankCode).toBe('ICICI')
  })
})
