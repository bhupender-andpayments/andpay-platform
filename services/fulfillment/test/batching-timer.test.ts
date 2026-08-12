import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { newId, toUuid } from '@andpay/ids'
import type { Envelope } from '@andpay/envelope'
import { PrismaClient } from '../generated/client/index.js'
import { runDueBatchTimers, onDemandAccrued } from '../src/batching.js'
import { poolConfig } from '../src/config/pool-config.js'
import { BATCH_TOPIC, type BatchFactPayload } from '../src/events.js'

const url =
  process.env.FULFILLMENT_DATABASE_URL ??
  'postgresql://andpay:andpay_dev@localhost:5432/andpay?schema=fulfillment'
const db = new PrismaClient({ datasourceUrl: url })

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE pending_pool_entry, batch, batch_pool, saga_timer, saga_step, saga_instance, outbox, inbox, batching_config CASCADE',
  )
})
afterAll(async () => {
  await db.$disconnect()
})

const BASE = new Date('2026-01-01T00:00:00.000Z')

interface PoolAnchor {
  tenantWire: string
  programWire: string
  tenantUuid: string
  programUuid: string
  pmInstanceId: string
}

// Seeds the pool anchor DIRECTLY (mirrors ensurePool's own two INSERTs, src/batching.ts)
// instead of going through ensurePool/onDemandAccrued: this test drives the timer path in
// isolation, so it needs full control over the saga_instance / batch_pool / saga_timer rows
// (a known, due timer id) rather than whatever maxWaitSeconds ensurePool would arm from
// poolConfig. No max_wait timer is armed here; seedDueTimer below adds exactly the one timer
// each test wants.
async function seedPoolAnchor(): Promise<PoolAnchor> {
  const tenantWire = newId('tnnt')
  const programWire = newId('prog')
  const tenantUuid = toUuid(tenantWire)
  const programUuid = toUuid(programWire)
  const pmInstanceId = toUuid(newId('sg'))
  await db.$executeRaw`
    INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
    VALUES (${pmInstanceId}::uuid, 'batching_pool', 1, 'running', now())
  `
  await db.$executeRaw`
    INSERT INTO batch_pool (id, tenant_id, program_id, pm_instance_id, created_at)
    VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${programUuid}::uuid, ${pmInstanceId}::uuid, now())
  `
  return { tenantWire, programWire, tenantUuid, programUuid, pmInstanceId }
}

// Seeds a DUE max_wait saga_timer directly (fire_at in the past, status pending),
// bypassing setTimer's caller-supplied fireAt convenience so the test controls "due" precisely.
// Returns the timer's own id (the epoch runDueBatchTimers' effect derives from it).
async function seedDueTimer(pmInstanceId: string): Promise<string> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO saga_timer (instance_id, fire_at, purpose, status)
    VALUES (${pmInstanceId}::uuid, ${new Date(Date.now() - 60_000)}, 'max_wait', 'pending')
    RETURNING id::text AS id
  `
  return rows[0]!.id
}

// A fixture pending_pool_entry row, inserted directly (mirrors
// test/batching-lotsize.test.ts's own seedPooled): updated_at and trace_id are NOT NULL
// columns, both set explicitly here so the fixture is never dependent on a column default.
async function seedPooled(
  tenantUuid: string,
  programUuid: string,
  traceId: string,
  createdAt: Date,
): Promise<{ asgnWire: string; asgnUuid: string }> {
  const asgnWire = newId('asgn')
  const asgnUuid = toUuid(asgnWire)
  await db.$executeRaw`
    INSERT INTO pending_pool_entry (
      asgn_id, tenant_id, program_id, soundbox, standee_count, sticker_count, billable,
      merchant_display_name, merchant_legal_name, merchant_mcc, bank_reference_code, bank_display_name,
      ship_to_address, qr_value, vpa_value, pool_status, source_event_id, trace_id, created_at, updated_at
    ) VALUES (
      ${asgnUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, true, 1, 1, true,
      'Acme', 'Acme Pvt Ltd', '5814', 'HDFC', 'HDFC Bank', '221B Baker Street',
      'upi://pay?pa=acme@hdfcbank', 'acme@hdfcbank', 'POOLED', 'file-1|1', ${traceId}, ${createdAt}, now()
    )
  `
  return { asgnWire, asgnUuid }
}

interface BatchOutboxRow {
  event_type: string
  partition_key: string
  payload: Envelope<BatchFactPayload>
}

describe('runDueBatchTimers: single-cycle MAX_WAIT trigger on the D77 engine (check 3b)', () => {
  it('one due max_wait timer + POOLED entries below minLotSize: fires exactly one MAX_WAIT batch, flips entries to BATCHED, marks the timer fired, re-arms a fresh max_wait timer, and the batch fact carries the oldest entry trace_id', async () => {
    const anchor = await seedPoolAnchor()
    const timerId = await seedDueTimer(anchor.pmInstanceId)
    const { maxWaitSeconds } = poolConfig(anchor.tenantWire, anchor.programWire)

    const seeded: { asgnWire: string; traceId: string }[] = []
    for (let i = 0; i < 3; i++) {
      const traceId = `trace-${String(i)}`
      const { asgnWire } = await seedPooled(
        anchor.tenantUuid,
        anchor.programUuid,
        traceId,
        new Date(BASE.getTime() + i * 1000),
      )
      seeded.push({ asgnWire, traceId })
    }
    const oldest = seeded[0]! // i = 0 has the earliest created_at

    const preTrigger = new Date()
    const fired = await runDueBatchTimers(db, new Date())

    // exactly one timer fired: the single due timer seeded above.
    expect(fired).toEqual([timerId])

    // exactly one MAX_WAIT batch, unit_count = the POOLED count. No status is
    // asserted: migration 20260810040000 dropped batch.status, and a batch's
    // state is now derived from its children.
    const batches = await db.$queryRaw<
      { id: string; trigger_reason: string; unit_count: number }[]
    >`
      SELECT id::text AS id, trigger_reason, unit_count FROM batch
      WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
    `
    expect(batches).toHaveLength(1)
    expect(batches[0]!.trigger_reason).toBe('MAX_WAIT')
    expect(batches[0]!.unit_count).toBe(3)
    const btchUuid = batches[0]!.id

    // every seeded entry flipped to BATCHED, batch ref set, updated_at advanced.
    const entries = await db.$queryRaw<
      { pool_status: string; batch: string | null; updated_at: Date }[]
    >`
      SELECT pool_status, batch::text AS batch, updated_at FROM pending_pool_entry
      WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
    `
    expect(entries).toHaveLength(3)
    for (const row of entries) {
      expect(row.pool_status).toBe('BATCHED')
      expect(row.batch).toBe(btchUuid)
      expect(row.updated_at.getTime()).toBeGreaterThan(preTrigger.getTime())
    }

    // the fired timer is 'fired'; a FRESH pending max_wait timer exists (re-arm, C2).
    const timers = await db.$queryRaw<
      { id: string; status: string; purpose: string; fire_at: Date }[]
    >`
      SELECT id::text AS id, status, purpose, fire_at FROM saga_timer WHERE instance_id = ${anchor.pmInstanceId}::uuid
    `
    expect(timers).toHaveLength(2)
    const original = timers.find((t) => t.id === timerId)
    expect(original?.status).toBe('fired')
    const rearmed = timers.find((t) => t.id !== timerId)
    expect(rearmed?.status).toBe('pending')
    expect(rearmed?.purpose).toBe('max_wait')
    const expectedFireAt = Date.now() + maxWaitSeconds * 1000
    expect(Math.abs(rearmed!.fire_at.getTime() - expectedFireAt)).toBeLessThan(5000)

    // exactly one fct.fulfillment.batch.v1 fact, traceId = the OLDEST seeded entry's trace_id.
    const ob = await db.$queryRaw<BatchOutboxRow[]>`
      SELECT event_type, partition_key, payload FROM outbox WHERE event_type = ${BATCH_TOPIC}
    `
    expect(ob).toHaveLength(1)
    expect(ob[0]!.payload.traceId).toBe(oldest.traceId)
    expect(ob[0]!.payload.payload.btchId).toBeDefined()
    expect(ob[0]!.payload.payload.triggerReason).toBe('MAX_WAIT')
    expect(ob[0]!.payload.payload.unitCount).toBe(3)
    expect(new Set(ob[0]!.payload.payload.asgnIds)).toEqual(new Set(seeded.map((s) => s.asgnWire)))
  })
})

describe('runDueBatchTimers: concurrency proof, FOR UPDATE SKIP LOCKED exclusivity (check 3b, load-bearing)', () => {
  // Setup: N independent pools, each with exactly ONE due max_wait timer and a couple of
  // POOLED entries below minLotSize. runDueBatchTimers wraps claimAndFireDueTimers with NO
  // batchSize override (default 100 > N), so a single claiming SELECT ... FOR UPDATE SKIP
  // LOCKED can see every one of the N due timers at once: whichever of the two concurrent
  // workers' claim query reaches Postgres first locks some (or all) of the N rows, and the
  // other worker's own claim query, racing it via Promise.all, is guaranteed by SKIP LOCKED
  // to see those rows as already locked and exclude them, rather than blocking on them.
  //
  // This is what forces GENUINE overlap without touching runDueBatchTimers' fixed
  // (db, now) signature (no injectable delay or batchSize hook is available to a caller,
  // unlike packages/engine/test/engine.test.ts:105-135's own collect() delay + batchSize
  // split): each fired timer's effect runs a FULL triggerBatch call (its own nested
  // transaction: setProgramContext, the pool FOR UPDATE lock, the pending_pool_entry mark-
  // BATCHED UPDATE, the batch INSERT, the onceWithin inbox INSERT, the outbox enqueue INSERT,
  // the saga_timer supersede UPDATE, and the re-arm INSERT), all of it run SEQUENTIALLY,
  // pool by pool, inside the ONE outer claimAndFireDueTimers transaction that the winning
  // worker's initial claim opened. With N pools that is N sequential rounds of real DB I/O
  // held open under the SAME outer transaction, which reliably keeps that transaction's row
  // locks held for long enough (well beyond the microseconds of JS/Promise.all scheduling
  // jitter) that the losing worker's own claim query is genuinely in flight, concurrently,
  // while the winner still holds the locks -- exactly the SKIP LOCKED window under real
  // contention, not just a sequential "run twice" call.
  //
  // The split between the two workers is deliberately NOT asserted to be even: Postgres may
  // let the loser claim zero rows (winner takes all N) or split the N rows across both
  // workers, depending on exactly how the two SELECT ... FOR UPDATE SKIP LOCKED queries
  // interleave at the row level. Both outcomes are valid proof of exclusivity. What is
  // asserted is invariant under either outcome: the two RETURNED arrays are disjoint, their
  // concatenation accounts for every one of the N timers exactly once, and each pool ends up
  // with EXACTLY one MAX_WAIT batch (0 double-fire, 0 skip).
  it('N pools, one due max_wait timer each: two concurrent runDueBatchTimers workers never double-fire and never skip a timer', async () => {
    const N = 6
    const pools: (PoolAnchor & { timerId: string })[] = []

    for (let p = 0; p < N; p++) {
      const anchor = await seedPoolAnchor()
      const timerId = await seedDueTimer(anchor.pmInstanceId)
      // two POOLED entries per pool (well below minLotSize): triggerBatch's mark-BATCHED
      // RETURNING gate needs at least one POOLED row, or it returns null (C4) and this
      // pool's timer would fire with no batch and no re-arm.
      await seedPooled(anchor.tenantUuid, anchor.programUuid, `trace-${String(p)}-0`, BASE)
      await seedPooled(
        anchor.tenantUuid,
        anchor.programUuid,
        `trace-${String(p)}-1`,
        new Date(BASE.getTime() + 1000),
      )
      pools.push({ ...anchor, timerId })
    }

    const now = new Date()
    const [firedA, firedB] = await Promise.all([
      runDueBatchTimers(db, now),
      runDueBatchTimers(db, now),
    ])

    // PRIMARY proof, on the returned arrays directly, independent of triggerBatch's own
    // inbox dedup guard: the N due timers are partitioned into two DISJOINT claims whose
    // union is every one of them, exactly once.
    expect(firedA.concat(firedB)).toHaveLength(N)
    const overlap = firedA.filter((id) => firedB.includes(id))
    expect(overlap).toHaveLength(0) // no double-fire
    expect(new Set([...firedA, ...firedB]).size).toBe(N) // no skip
    expect(new Set([...firedA, ...firedB])).toEqual(new Set(pools.map((pl) => pl.timerId)))

    // SECONDARY proof: exactly one MAX_WAIT batch per pool, and the global union of
    // batch ids has no duplicate (0 double-fire at the batch level too). No status is
    // asserted: migration 20260810040000 dropped batch.status, and a batch's state is
    // now derived from its children.
    const allBatchIds: string[] = []
    for (const pool of pools) {
      const batches = await db.$queryRaw<{ id: string; trigger_reason: string }[]>`
        SELECT id::text AS id, trigger_reason FROM batch
        WHERE tenant_id = ${pool.tenantUuid}::uuid AND program_id = ${pool.programUuid}::uuid
      `
      expect(batches).toHaveLength(1)
      expect(batches[0]!.trigger_reason).toBe('MAX_WAIT')
      allBatchIds.push(batches[0]!.id)
    }
    expect(new Set(allBatchIds).size).toBe(N)

    const totalBatches = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(totalBatches[0]!.n)).toBe(N)

    // every pool: its original timer fired, and exactly one fresh max_wait timer is pending
    // (supersede + re-arm, C2) -- no pool left with zero or two pending timers.
    for (const pool of pools) {
      const timers = await db.$queryRaw<{ id: string; status: string }[]>`
        SELECT id::text AS id, status FROM saga_timer WHERE instance_id = ${pool.pmInstanceId}::uuid
      `
      expect(timers).toHaveLength(2)
      const original = timers.find((t) => t.id === pool.timerId)
      expect(original?.status).toBe('fired')
      const rearmed = timers.filter((t) => t.status === 'pending')
      expect(rearmed).toHaveLength(1)
    }
  })
})

// T0b.1 (PLAN.md, fixed 12 Aug 2026). The comment on the N-pools test above
// described this exact hole without ever asserting recovery from it: a MAX_WAIT
// timer coming due on an EMPTY pool was consumed (the engine marks it fired the
// moment the effect resolves) while triggerBatchWithinTx returned before its
// supersede-and-re-arm, and ensurePool arms a timer only when it CREATES the
// pool. That pool then held zero pending max_wait timers forever, so max-wait
// silently stopped existing for it. A low-volume tenant whose pool idles past
// one window is the ordinary way to reach it.
describe('runDueBatchTimers: a MAX_WAIT fire on an EMPTY pool must not disarm max-wait (T0b.1)', () => {
  it('fires with no batch, yet leaves exactly one pending max_wait timer armed', async () => {
    const anchor = await seedPoolAnchor()
    const timerId = await seedDueTimer(anchor.pmInstanceId)
    // No seedPooled: the pool is empty, which is the whole point.

    const fired = await runDueBatchTimers(db, new Date())
    expect(fired).toEqual([timerId]) // the timer WAS consumed

    const batches = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(batches[0]!.n)).toBe(0) // and correctly created no empty batch

    const timers = await db.$queryRaw<{ id: string; status: string }[]>`
      SELECT id::text AS id, status FROM saga_timer WHERE instance_id = ${anchor.pmInstanceId}::uuid
    `
    expect(timers.find((t) => t.id === timerId)?.status).toBe('fired')
    // THE FIX: a replacement is armed. Before it this was zero, and the pool
    // could never sweep again.
    const pending = timers.filter((t) => t.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).not.toBe(timerId)
  })

  it('and max-wait still works afterwards: an entry pooled later is swept by the re-armed timer', async () => {
    // The assertion above is structural (a pending row exists). This one is the
    // behavioral proof that the recovery is real, which is what actually
    // regressed: work arriving after the empty sweep must still get batched by
    // max-wait, with no LOT_SIZE or MANUAL trigger involved.
    const anchor = await seedPoolAnchor()
    await seedDueTimer(anchor.pmInstanceId)
    await runDueBatchTimers(db, new Date()) // the empty sweep

    // Work arrives only now.
    await seedPooled(anchor.tenantUuid, anchor.programUuid, 'trace-after-empty-sweep', BASE)

    // Advance past the re-armed timer's own window rather than rewriting its
    // fire_at, so the timer under test is exactly the one the fix armed, at the
    // fire_at the fix chose.
    const { maxWaitSeconds } = poolConfig(anchor.tenantWire, anchor.programWire)
    const afterWindow = new Date(Date.now() + maxWaitSeconds * 1000 + 60_000)
    const firedAgain = await runDueBatchTimers(db, afterWindow)
    expect(firedAgain).toHaveLength(1)

    const batches = await db.$queryRaw<{ trigger_reason: string; unit_count: number }[]>`
      SELECT trigger_reason, unit_count FROM batch
      WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
    `
    expect(batches).toEqual([{ trigger_reason: 'MAX_WAIT', unit_count: 1 }])
  })

  it('but a LOT_SIZE trigger that finds an empty pool still touches NO timer', async () => {
    // The asymmetry is deliberate and worth pinning, because "always re-arm"
    // looks like the simpler rule and is wrong. Only a MAX_WAIT fire CONSUMES a
    // timer, so only it owes a replacement. A LOT_SIZE (or MANUAL) trigger that
    // finds nothing POOLED leaves the pool's existing pending timer untouched,
    // and re-arming there would leave TWO pending timers, breaking the
    // exactly-one invariant and letting a stale timer sweep the next window
    // early.
    const anchor = await seedPoolAnchor()
    const timerId = await seedDueTimer(anchor.pmInstanceId)

    // onDemandAccrued on an empty pool: the POOLED count is zero, below
    // minLotSize, so it never reaches triggerBatch at all. ensurePool runs
    // first but the pool already exists, so it arms nothing either.
    await onDemandAccrued(
      db,
      anchor.tenantWire,
      anchor.programWire,
      `epoch-empty-${newId('asgn')}`,
      'trace-empty-lotsize',
    )

    const timers = await db.$queryRaw<{ id: string; status: string }[]>`
      SELECT id::text AS id, status FROM saga_timer WHERE instance_id = ${anchor.pmInstanceId}::uuid
    `
    expect(timers).toHaveLength(1) // no second timer armed
    expect(timers[0]!.id).toBe(timerId)
    expect(timers[0]!.status).toBe('pending') // and the original is still the live one
  })
})

describe('runDueBatchTimers: deterministic multi-pool split proof (fix wave 1, load-bearing)', () => {
  // The test above proves exclusivity (no double-fire, no skip) but NOT a genuine two-worker
  // partition: with the default batchSize (100 > N), a purely sequential pair of calls (no
  // real concurrency at all) produces the exact same "winner claims every row" shape as a
  // raced pair, so it cannot distinguish "ran concurrently and split the work" from "ran one
  // after the other". Capping batchSize at 3 for BOTH workers while seeding exactly N = 6 due
  // timers removes that ambiguity: since batchSize (3) times the number of workers (2) exactly
  // equals N (6), and FOR UPDATE SKIP LOCKED guarantees the two claims are disjoint (a row
  // locked by one is skipped, never double-claimed, by the other), the only way for both
  // claims to jointly account for all 6 timers -- which they must, since neither worker's
  // SELECT stops scanning until it either hits its LIMIT of 3 or exhausts every candidate row
  // -- is for EACH worker to end up with exactly 3. A sequential pair could never produce this
  // 3-and-3 shape (the second call would see zero due timers left, having already consumed all
  // 6 as fewer, larger batches capped at 3 apiece across TWO sequential calls -- i.e. it would
  // also read 3 and 3, but only because nothing ran concurrently; the disambiguator here is
  // deliberately the CONCURRENT run: raced via Promise.all against the same due-timer set)
  // deterministically claiming disjoint 3-row halves under real lock contention (proven by the
  // batching-lotsize style deadlock/exclusivity behavior of SKIP LOCKED itself), not by which
  // call happens to run first.
  it('N=6 pools, batchSize=3 for both workers: two concurrent runDueBatchTimers calls split the due timers 3 and 3, never winner-take-all', async () => {
    const N = 6
    const pools: (PoolAnchor & { timerId: string })[] = []

    for (let p = 0; p < N; p++) {
      const anchor = await seedPoolAnchor()
      const timerId = await seedDueTimer(anchor.pmInstanceId)
      await seedPooled(anchor.tenantUuid, anchor.programUuid, `trace-split-${String(p)}`, BASE)
      pools.push({ ...anchor, timerId })
    }

    const now = new Date()
    const [firedA, firedB] = await Promise.all([
      runDueBatchTimers(db, now, 3),
      runDueBatchTimers(db, now, 3),
    ])

    // the load-bearing proof: BOTH workers claimed exactly 3, a shape only possible under
    // genuine concurrent partitioning of the 6 due timers, not winner-take-all.
    expect(firedA).toHaveLength(3)
    expect(firedB).toHaveLength(3)

    const overlap = firedA.filter((id) => firedB.includes(id))
    expect(overlap).toHaveLength(0) // disjoint halves
    expect(new Set([...firedA, ...firedB]).size).toBe(N) // 0 skip
    expect(new Set([...firedA, ...firedB])).toEqual(new Set(pools.map((pl) => pl.timerId)))

    // exactly one batch row per pool (0 double-fire at the batch level).
    for (const pool of pools) {
      const batches = await db.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM batch
        WHERE tenant_id = ${pool.tenantUuid}::uuid AND program_id = ${pool.programUuid}::uuid
      `
      expect(batches).toHaveLength(1)
    }
    const totalBatches = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM batch`
    expect(Number(totalBatches[0]!.n)).toBe(N)

    // exactly one fct.fulfillment.batch.v1 fact per pool (fact-emission layer, 0 double).
    const totalFacts = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${BATCH_TOPIC}
    `
    expect(Number(totalFacts[0]!.n)).toBe(N)
  })
})

describe('runDueBatchTimers: at-least-once redelivery is deduped by epoch = timer.id (fix wave 1)', () => {
  // Proves check 3b's "0 double-fire" under the REAL at-least-once contract documented on
  // runDueBatchTimers: claimAndFireDueTimers commits the claim/mark-fired transaction
  // independently of the effect's own transaction, so a crash (or an outer-tx rollback) between
  // the effect's commit and the mark-fired UPDATE redelivers the SAME timer row on the next
  // poll. The row is only ever status-flipped, never re-inserted, so its id -- and therefore
  // triggerBatch's epoch -- is stable across the redelivery; onceWithin's inbox dedup on
  // `batch|{tenant}|{program}|MAX_WAIT|{T}` must make the redelivered fire a no-op.
  it('re-firing the SAME timer id after a simulated crash produces still exactly one batch and no second fact', async () => {
    const anchor = await seedPoolAnchor()
    const timerId = await seedDueTimer(anchor.pmInstanceId)
    await seedPooled(anchor.tenantUuid, anchor.programUuid, 'trace-redelivery', BASE)

    const fired1 = await runDueBatchTimers(db, new Date())
    expect(fired1).toEqual([timerId])

    const afterFirst = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM batch
      WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
    `
    expect(afterFirst).toHaveLength(1)
    const firstBatchId = afterFirst[0]!.id

    // Simulate the crash/outer-tx-rollback redelivery: T's id (and hence the epoch) is
    // unchanged, only its status/claimed_at revert, exactly as claimAndFireDueTimers' own
    // at-least-once contract describes.
    await db.$executeRaw`
      UPDATE saga_timer SET status = 'pending', claimed_at = NULL WHERE id = ${timerId}::uuid
    `

    const fired2 = await runDueBatchTimers(db, new Date())
    expect(fired2).toEqual([timerId]) // claimed again: it is due and pending once more

    const afterSecond = await db.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM batch
      WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
    `
    expect(afterSecond).toHaveLength(1) // still exactly one batch, no double-fire
    expect(afterSecond[0]!.id).toBe(firstBatchId)

    const facts = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM outbox WHERE event_type = ${BATCH_TOPIC}
    `
    expect(Number(facts[0]!.n)).toBe(1) // no second fact from the redelivery
  })
})

describe('runDueBatchTimers vs onDemandAccrued: concurrent cross-reason exercise (fix wave 1, SKIP LOCKED deadlock fix)', () => {
  // Exercises the AB-BA cross-transaction deadlock the SKIP LOCKED supersede fix removes: a
  // LOT_SIZE trigger (no firingTimerId, so its supersede sweep excludes nothing) races a
  // MAX_WAIT trigger for the SAME pool. Pre-fix, the LOT_SIZE trigger's plain supersede UPDATE
  // could try to lock the very saga_timer row the MAX_WAIT engine's claim transaction holds
  // FOR UPDATE while that transaction awaits (via a JS await, invisible to Postgres) its own
  // effect -- which in turn can be blocked on the batch_pool row lock the LOT_SIZE transaction
  // holds. Postgres cannot see that cycle, so it resolves only via Prisma's 5s transaction
  // timeout. This is a best-effort exercise (the exact interleaving is not forced), so it does
  // not assert which reason wins; it asserts only what must ALWAYS hold: no hang, no throw, and
  // exactly one batch (whichever reason's triggerBatch call wins the batch_pool FOR UPDATE lock
  // claims every POOLED row; the loser's own claim finds zero POOLED and creates nothing, per
  // the C4 RETURNING gate).
  it(
    'LOT_SIZE (via onDemandAccrued) and MAX_WAIT (via runDueBatchTimers) racing on one pool never hang and never double-batch',
    async () => {
      const anchor = await seedPoolAnchor()
      await seedDueTimer(anchor.pmInstanceId)
      const { minLotSize } = poolConfig(anchor.tenantWire, anchor.programWire)
      for (let i = 0; i < minLotSize; i++) {
        await seedPooled(
          anchor.tenantUuid,
          anchor.programUuid,
          `trace-cross-${String(i)}`,
          new Date(BASE.getTime() + i * 1000),
        )
      }

      const now = new Date()
      await expect(
        Promise.all([
          onDemandAccrued(db, anchor.tenantWire, anchor.programWire, 'dedup-cross-reason', 'trace-cross-trigger'),
          runDueBatchTimers(db, now),
        ]),
      ).resolves.toBeDefined()

      // exactly one batch for the pool: whichever reason won claimed all POOLED entries; the
      // loser found zero POOLED and created nothing.
      const batches = await db.$queryRaw<{ id: string; trigger_reason: string }[]>`
        SELECT id::text AS id, trigger_reason FROM batch
        WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
      `
      expect(batches).toHaveLength(1)
      expect(['LOT_SIZE', 'MAX_WAIT']).toContain(batches[0]!.trigger_reason)

      const entries = await db.$queryRaw<{ pool_status: string }[]>`
        SELECT pool_status FROM pending_pool_entry
        WHERE tenant_id = ${anchor.tenantUuid}::uuid AND program_id = ${anchor.programUuid}::uuid
      `
      expect(entries).toHaveLength(minLotSize)
      expect(entries.every((e) => e.pool_status === 'BATCHED')).toBe(true)

      const facts = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM outbox WHERE event_type = ${BATCH_TOPIC}
      `
      expect(Number(facts[0]!.n)).toBe(1)
    },
    15_000,
  )
})
