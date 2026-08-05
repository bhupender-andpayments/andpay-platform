import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newEnvelope, type Envelope } from '@andpay/envelope'
import { newId, toUuid, fromUuid } from '@andpay/ids'
import {
  PrismaClient,
  projectDemandFact,
  onDemandAccrued,
  poolConfig,
  BATCH_TOPIC,
  type AssignmentFactView,
} from '@andpay/fulfillment-service'
import { runBatchingTick } from '../src/tick.js'

// Mirrors services/fulfillment/test/batching-timer.test.ts and
// services/fulfillment/test/pool.test.ts's own setup shape, but as a
// consumer OUTSIDE the fulfillment service: everything here goes through the
// package's public exports (@andpay/fulfillment-service) only, never a
// services/fulfillment-internal path. Task brief requirement: arm the due
// max_wait timer using ONLY exported fulfillment functions.
const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

const TABLES =
  'pending_pool_entry, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox, batching_config'

// TRUNCATE first, seed AFTER (never before): each test seeds its own fixtures
// once the tables are known-empty.
beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
})
afterAll(async () => {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES} CASCADE`)
  await db.$disconnect()
})

// A fixture fct.tms.assignment.v1 consumer view (T7: declared locally, never
// imported from the tms service), mirroring services/fulfillment/test/pool.test.ts's
// own fixturePayload.
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
    stickerCount: 1,
    billable: true,
    demandState: 'pooled-for-fulfillment',
    sourceEventId: 'file-1|1',
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

// Arms exactly one pending, due-later max_wait timer for a fresh
// (tenantWire, programWire) pool, using ONLY @andpay/fulfillment-service's own
// exported demand-projection path: projectDemandFact adds ONE POOLED entry
// (well below DEFAULT_POOL_CFG.minLotSize = 50), then onDemandAccrued
// resolves that count against minLotSize (below it, so LOT_SIZE never fires)
// and, via its own ensurePool call, creates the pool anchor plus its FIRST
// max_wait timer armed at (now + maxWaitSeconds). The timer is not due yet at
// real wall-clock time; the caller advances `now` past it explicitly.
async function armPendingMaxWaitTimer(): Promise<{ tenantWire: string; programWire: string; maxWaitSeconds: number }> {
  const tenantWire = newId('tnnt')
  const programWire = newId('prog')
  const payload = fixturePayload({ tnntId: tenantWire, progId: programWire })
  const env = demandEnv(payload, `evt-${payload.asgnId}|fulfillment.pool`, `trace-${payload.asgnId}`)

  const projected = await projectDemandFact(db, env)
  expect(projected.deduped).toBe(false)

  const { maxWaitSeconds } = poolConfig(tenantWire, programWire)
  const accrued = await onDemandAccrued(db, tenantWire, programWire, `dedup-${payload.asgnId}`, `trace-${payload.asgnId}`)
  expect(accrued.triggered).toBe(false) // 1 entry, well below minLotSize (50): LOT_SIZE never fires

  return { tenantWire, programWire, maxWaitSeconds }
}

describe('runBatchingTick (Phase 6 scheduler: the process that CALLS the already-built D77 driver on a cadence)', () => {
  it('an armed max_wait timer, made due by a FUTURE `now`, fires exactly one MAX_WAIT batch', async () => {
    const { tenantWire, programWire, maxWaitSeconds } = await armPendingMaxWaitTimer()

    // The armed timer's fire_at is (real Date.now() at arm time) + maxWaitSeconds.
    // A `now` well past that (+ a generous margin for test wall-clock drift)
    // is unambiguously due, without touching any engine internals.
    const due = new Date(Date.now() + maxWaitSeconds * 1000 + 5_000)
    const fired = await runBatchingTick(db, due)

    expect(fired).toHaveLength(1)

    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const batches = await db.$queryRaw<{ status: string; trigger_reason: string }[]>`
      SELECT status, trigger_reason FROM batch
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    expect(batches).toHaveLength(1)
    expect(batches[0]!.status).toBe('BORN')
    expect(batches[0]!.trigger_reason).toBe('MAX_WAIT')
  })

  it('nothing due: returns [] and is a safe no-op (no batch created)', async () => {
    // An armed-but-not-yet-due timer exists (fire_at far in the future), and
    // a `now` that is still before it must fire nothing.
    await armPendingMaxWaitTimer()

    const fired = await runBatchingTick(db, new Date())
    expect(fired).toEqual([])

    const batchCount = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batchCount[0]!.n)).toBe(0)
  })

  it('an empty pool table: returns [] and is a safe no-op', async () => {
    const fired = await runBatchingTick(db, new Date())
    expect(fired).toEqual([])
  })

  it('two concurrent runBatchingTick calls on the same due pool fire it EXACTLY once (overlap safety through the wrapper, mirroring services/fulfillment/test/batching-timer.test.ts)', async () => {
    const { tenantWire, programWire, maxWaitSeconds } = await armPendingMaxWaitTimer()
    const due = new Date(Date.now() + maxWaitSeconds * 1000 + 5_000)

    const [firedA, firedB] = await Promise.all([runBatchingTick(db, due), runBatchingTick(db, due)])

    // The single due timer is claimed by exactly one of the two racing calls
    // (FOR UPDATE SKIP LOCKED, decision 77): no double-fire, no skip.
    const combined = [...firedA, ...firedB]
    expect(combined).toHaveLength(1)

    const tenantUuid = toUuid(tenantWire)
    const programUuid = toUuid(programWire)
    const batches = await db.$queryRaw<{ id: string; trigger_reason: string }[]>`
      SELECT id::text AS id, trigger_reason FROM batch
      WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    expect(batches).toHaveLength(1)
    expect(batches[0]!.trigger_reason).toBe('MAX_WAIT')

    const factCount = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${BATCH_TOPIC}
    `
    expect(Number(factCount[0]!.n)).toBe(1)
  })
})
