import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import { PrismaClient } from '../generated/client/index.js'
import { projectDemandFact } from '../src/pool.js'
import type { AssignmentFactView } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE pending_pool_entry, outbox, inbox')
})
afterAll(async () => {
  await db.$disconnect()
})

// A fixture fct.tms.assignment.v1 consumer view (T7: declared locally, never
// imported from the tms service). Field names mirror AssignmentFactView
// (src/events.ts, Task 3), which mirrors the tms side wire payload 1:1.
function fixturePayload(overrides: Partial<AssignmentFactView> = {}): AssignmentFactView {
  const asgnId = fromUuid('asgn', toUuid(newId('asgn')))
  const mrchId = fromUuid('mrch', toUuid(newId('mrch')))
  const progId = fromUuid('prog', toUuid(newId('prog')))
  const tnntId = fromUuid('tnnt', toUuid(newId('tnnt')))
  return {
    asgnId,
    mrchId,
    progId,
    tnntId,
    merchantDisplayName: 'Acme',
    merchantLegalName: 'Acme Pvt Ltd',
    merchantMcc: '5814',
    bankReferenceCode: 'HDFC',
    bankDisplayName: 'HDFC Bank',
    shipToAddress: '221B Baker Street',
    qrValue: 'upi://pay?pa=acme@hdfcbank',
    vpaValue: 'acme@hdfcbank',
    soundbox: true,
    standeeCount: 1,
    stickerCount: 2,
    billable: true,
    demandState: 'pooled-for-fulfillment',
    sourceEventId: 'file-1|1',
    contactName: 'Jane Doe',
    mobile: '9876543210',
    ...overrides,
  }
}

function demandEnv(payload: AssignmentFactView, dedupKey: string, traceId: string): Envelope<AssignmentFactView> {
  return newEnvelope({
    type: 'fct.tms.assignment.v1',
    version: 1,
    subject: payload.asgnId,
    dedupKey,
    traceId,
    payload,
  })
}

describe('projectDemandFact carries the dispatch group (Task 5, W-5)', () => {
  it('an assignment fact WITH dispatchGroup populates pending_pool_entry.dispatch_group', async () => {
    const payload = fixturePayload({ dispatchGroup: 'COLLATERAL' })
    const env = demandEnv(payload, 'evt-w5-with|fulfillment.pool', 'trace-w5-with')

    const res = await projectDemandFact(db, env)
    expect(res.deduped).toBe(false)

    const rows = await db.$queryRaw<{ dispatch_group: string | null }[]>`
      SELECT dispatch_group FROM pending_pool_entry WHERE asgn_id = ${toUuid(payload.asgnId)}::uuid
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatch_group).toBe('COLLATERAL')
  })

  it('an assignment fact WITHOUT dispatchGroup (legacy, pre-split) leaves pending_pool_entry.dispatch_group NULL', async () => {
    const legacy = fixturePayload()
    delete (legacy as Partial<AssignmentFactView>).dispatchGroup // legacy fact: no dispatchGroup key at all on the wire
    const env = demandEnv(legacy, 'evt-w5-without|fulfillment.pool', 'trace-w5-without')

    const res = await projectDemandFact(db, env)
    expect(res.deduped).toBe(false)

    const rows = await db.$queryRaw<{ dispatch_group: string | null }[]>`
      SELECT dispatch_group FROM pending_pool_entry WHERE asgn_id = ${toUuid(legacy.asgnId)}::uuid
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]!.dispatch_group).toBeNull()
  })
})
