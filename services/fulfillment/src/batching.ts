import { newId, toUuid, fromUuid } from '@andpay/ids'
import { onceWithin, enqueue } from '@andpay/outbox'
import { setTimer, claimAndFireDueTimers } from '@andpay/engine'
import type { FulfillmentDb } from './db.js'
import { CONSUMER, setProgramContext, type Tx } from './internal.js'
import { enterWriteScope, enterWriteRole } from './write-context.js'
import { resolvePoolConfig } from './config/pool-config.js'
import { BATCH_TOPIC, batchFactEnvelope } from './events.js'
import type { OpsActor } from './vendor.js'

/**
 * Thrown internally when ensurePool's own transaction loses the batch_pool
 * ON CONFLICT (tenant_id, program_id) DO NOTHING race. Throwing rolls back the
 * WHOLE creating transaction, including the just-inserted saga_instance, so
 * the losing racer leaves no orphan saga_instance behind. Never escapes this
 * module (caught in ensurePool's own catch).
 */
class PoolRaceLost extends Error {
  constructor() {
    super('batch_pool creation race lost; the winning racer holds the row')
    this.name = 'PoolRaceLost'
  }
}

/**
 * Thrown internally when triggerBatch's pool lock SELECT finds no batch_pool
 * row (should not happen: ensurePool always runs first and creates the
 * anchor before any trigger reason can fire). This is an anomaly, not a
 * legitimate no-op, so it MUST throw rather than return: throwing from inside
 * the onceWithin callback rolls back the WHOLE enclosing $transaction,
 * including the just-inserted inbox dedup row, so the epoch is never burned
 * and a legitimate later retry (once the anomaly is fixed) can still create
 * the batch. A bare return here would let the transaction commit the inbox
 * row while creating nothing, permanently deduping away every future retry
 * for that epoch. Deliberately NOT caught in triggerBatch: it propagates to
 * the caller so the anomaly surfaces instead of being silently swallowed.
 */
class PoolNotFound extends Error {
  constructor() {
    super('batch_pool row not found for trigger; ensurePool should have run first')
    this.name = 'PoolNotFound'
  }
}

export interface PoolAnchor {
  poolId: string
  pmInstanceId: string
}

/**
 * Find-or-create the per-(tenant, program) batch_pool anchor: the row that
 * maps a pool to its saga_instance (the D77 PM instance the pool's timers hang
 * off, D107a) so the engine's setTimer (which needs a saga_instance FK) can
 * arm the pool's max_wait timer.
 *
 * Fast path: a plain SELECT, the common case on every accrual (called on
 * every non-deduped demand fact; no transaction, no lock). On a miss,
 * inline-atomic create: this duplicates SagaEngine.start's 3-line
 * saga_instance INSERT rather than calling the class method, because start()
 * writes on its own connection and cannot join this tx; setTimer /
 * claimAndFireDueTimers ARE reused (the engine itself, not a re-implementation
 * of it). The batch_pool INSERT is ON CONFLICT (tenant_id, program_id) DO
 * NOTHING; a losing racer throws PoolRaceLost, which rolls back its own
 * saga_instance INSERT too (no orphan saga_instance is ever committed), then
 * re-SELECTs batch_pool: the ON CONFLICT DO NOTHING blocks on the winning
 * row's lock until that transaction commits, so the re-SELECT is guaranteed to
 * find the row.
 */
export async function ensurePool(
  db: FulfillmentDb,
  tenantWire: string,
  programWire: string,
): Promise<PoolAnchor> {
  const tenantUuid = toUuid(tenantWire)
  const programUuid = toUuid(programWire)

  const existing = await db.$queryRaw<{ id: string; pm_instance_id: string }[]>`
    SELECT id::text AS id, pm_instance_id::text AS pm_instance_id
    FROM batch_pool WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
  `
  if (existing.length > 0) {
    return { poolId: existing[0]!.id, pmInstanceId: existing[0]!.pm_instance_id }
  }

  try {
    return await db.$transaction(async (tx: Tx) => {
      // batch_pool is PROGRAM-SCOPED (07.B): the write-gate needs app.program_id
      // set before the INSERT below (critique fix). Mechanical spec 10d Task 4
      // swap (setProgramContext -> enterWriteScope): enters fulfillment_write
      // and binds the program in one call, so the batch_pool WITH CHECK bites
      // under the non-owner role.
      //
      // Fix wave (spec 10d consolidated defect): moved to the TOP of the
      // transaction, before the saga_instance INSERT below (previously the
      // FIRST statement in this transaction, running as the table owner).
      await enterWriteScope(tx, 'fulfillment_write', programUuid)

      const sagaId = newId('sg')
      const pmInstanceId = toUuid(sagaId)
      await tx.$executeRaw`
        INSERT INTO saga_instance (id, flow_type, flow_version, status, updated_at)
        VALUES (${pmInstanceId}::uuid, 'batching_pool', 1, 'running', now())
      `

      const won = await tx.$queryRaw<{ id: string; pm_instance_id: string }[]>`
        INSERT INTO batch_pool (id, tenant_id, program_id, pm_instance_id, created_at)
        VALUES (gen_random_uuid(), ${tenantUuid}::uuid, ${programUuid}::uuid, ${pmInstanceId}::uuid, now())
        ON CONFLICT (tenant_id, program_id) DO NOTHING
        RETURNING id::text AS id, pm_instance_id::text AS pm_instance_id
      `
      if (won.length === 0) {
        throw new PoolRaceLost()
      }

      // Arm the FIRST max-wait window for the newly created pool. The max-wait
      // duration is resolved from batching_config (T6) under this same tx (the
      // fulfillment_write role is already entered above and is granted SELECT on
      // batching_config); an empty store yields the code DEFAULT.
      const cfg = await resolvePoolConfig(tx, tenantWire, programWire)
      await setTimer(
        tx,
        pmInstanceId,
        new Date(Date.now() + cfg.maxWaitSeconds * 1000),
        'max_wait',
      )

      return { poolId: won[0]!.id, pmInstanceId: won[0]!.pm_instance_id }
    })
  } catch (e) {
    if (!(e instanceof PoolRaceLost)) throw e

    const rows = await db.$queryRaw<{ id: string; pm_instance_id: string }[]>`
      SELECT id::text AS id, pm_instance_id::text AS pm_instance_id
      FROM batch_pool WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
    `
    const row = rows[0]
    if (!row) throw e // should never happen: the winner is guaranteed to have committed
    return { poolId: row.id, pmInstanceId: row.pm_instance_id }
  }
}

export interface TriggerBatchOpts {
  /** The onceWithin idempotency epoch, scoped by `{tenant}|{program}|{reason}`. */
  epoch: string
  /** The firing DueTimer.id for a MAX_WAIT trigger (Task 9); left pending by the supersede sweep. */
  firingTimerId?: string
  /** The class-3 actor for a MANUAL trigger (Task 10); recorded on batch.triggered_by_actor. */
  actorUuid?: string
  /**
   * The operator's free-text reason for a MANUAL trigger (BRD 5.3.4 force
   * dispatch); recorded on batch.trigger_note. Optional on this shape and
   * absent from both automatic callers: LOT_SIZE fires because the pool reached
   * minLotSize and MAX_WAIT because a timer came due, so neither has a human
   * behind it and both persist NULL. `manualBatch` (src/ops.ts) is the only
   * caller that sets it, and it REQUIRES the reason of its own callers and
   * validates it before this point.
   *
   * Stays on the domain row only: it is never added to the batch fact (fact
   * payloads are IDs and enums, S7) and never to the co-committed 6e authz
   * record (DD1, the same rule shpt_status_event.override_reason follows).
   */
  triggerNote?: string
  /**
   * The triggering demand fact's traceId (LOT_SIZE only). Deliberately NOT
   * used for the batch fact's traceId: to keep trace derivation uniform and
   * testable across every trigger reason, triggerBatch always derives the
   * batch fact's traceId from the deterministically-oldest claimed
   * pending_pool_entry's trace_id instead (one documented rule for LOT_SIZE,
   * MAX_WAIT, and MANUAL alike, check 8). Kept on the options shape so a
   * caller may still pass it without a type error.
   */
  traceId?: string
}

/**
 * Create a Batch from every currently-POOLED pending_pool_entry row of one
 * (tenant, program) pool, for the given trigger reason. Shared by LOT_SIZE
 * (Task 8), MAX_WAIT (Task 9), and MANUAL (Task 10).
 *
 * ONE db.$transaction (E1): the whole body runs under
 * `onceWithin(tx, CONSUMER, "batch|{tenant}|{program}|{reason}|{epoch}", fn)`,
 * so a redelivered trigger for the same epoch is a no-op.
 *
 * Inside fn:
 *  - `SELECT ... FROM batch_pool ... FOR UPDATE` locks the pool row, which
 *    serializes EVERY trigger reason on this pool (critical fix C4): LOT_SIZE
 *    and MAX_WAIT can never both claim the same POOLED rows.
 *  - the pending_pool_entry mark-BATCHED UPDATE's RETURNING row count IS the
 *    gate: an empty return (nothing POOLED) creates no batch and touches no
 *    timer (C4 fix). Postgres does not support ORDER BY on an
 *    UPDATE ... RETURNING, so the deterministic-oldest ordering (by
 *    created_at, then id) is done in JS over the returned rows.
 *  - the batch fact's traceId is the deterministically-oldest claimed entry's
 *    trace_id, for every reason (documented rule above).
 *  - the pool's timers are superseded-and-re-armed (critique fix C2): every
 *    other pending timer on the pool is superseded and exactly one fresh
 *    max_wait timer is armed, so at most one pending timer per pool survives
 *    and a stale timer can never prematurely sweep the next window.
 *
 * Returns null when the epoch was already processed (deduped) or nothing was
 * POOLED (no spurious/empty batch).
 */
// Injected-tx variant (spec 10c Task 4): the current body verbatim minus the
// db.$transaction wrapper, so a later ops API can run this effect, the E6
// onceWithin dedup, and a server-resolved write scope together in ONE
// caller-supplied transaction. triggerBatch (below) delegates to this.
export async function triggerBatchWithinTx(
  tx: Tx,
  tenantWire: string,
  programWire: string,
  reason: string,
  opts: TriggerBatchOpts,
): Promise<{ btchId: string; unitCount: number } | null> {
  const tenantUuid = toUuid(tenantWire)
  const programUuid = toUuid(programWire)
  let result: { btchId: string; unitCount: number } | null = null

  await onceWithin(
    tx,
    CONSUMER,
    `batch|${tenantWire}|${programWire}|${reason}|${opts.epoch}`,
    async () => {
        // pending_pool_entry and batch are PROGRAM-SCOPED (07.A).
        await setProgramContext(tx, programUuid)

        // The pool lock: serializes every trigger reason on this pool (C4 fix).
        const pool = await tx.$queryRaw<{ pm_instance_id: string }[]>`
          SELECT pm_instance_id::text AS pm_instance_id FROM batch_pool
          WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid
          FOR UPDATE
        `
        // Anomaly, not a legitimate no-op (see PoolNotFound doc comment): throw
        // so the whole transaction, inbox insert included, rolls back and the
        // epoch stays retryable, instead of a bare return committing the dedup
        // row over nothing.
        if (pool.length === 0) throw new PoolNotFound()
        const pmInstanceId = pool[0]!.pm_instance_id

        const btchUuid = toUuid(newId('btch'))

        const claimed = await tx.$queryRaw<
          { id: string; asgn_id: string; trace_id: string; created_at: Date }[]
        >`
          UPDATE pending_pool_entry
          SET pool_status = 'BATCHED', batch = ${btchUuid}::uuid, updated_at = now()
          WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid AND pool_status = 'POOLED'
          RETURNING id::text AS id, asgn_id::text AS asgn_id, trace_id, created_at
        `
        if (claimed.length === 0) return // nothing POOLED: no batch, no timer churn

        const sorted = [...claimed].sort((a, b) => {
          const byCreatedAt = a.created_at.getTime() - b.created_at.getTime()
          if (byCreatedAt !== 0) return byCreatedAt
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        })
        const oldestTraceId = sorted[0]!.trace_id
        const btchWire = fromUuid('btch', btchUuid)

        // trigger_note is the BRD 5.3.4 force-dispatch reason and is set only by
        // the MANUAL ops path; `?? null` is what makes a LOT_SIZE or MAX_WAIT
        // batch persist a NULL note rather than an invented placeholder.
        await tx.$executeRaw`
          INSERT INTO batch (id, tenant_id, program_id, trigger_reason, triggered_by_actor, trigger_note, unit_count, updated_at)
          VALUES (${btchUuid}::uuid, ${tenantUuid}::uuid, ${programUuid}::uuid, ${reason}, ${opts.actorUuid ?? null}::uuid, ${opts.triggerNote ?? null}, ${claimed.length}, now())
        `

        await enqueue(tx, {
          aggregateType: 'batch',
          aggregateId: btchWire,
          eventType: BATCH_TOPIC,
          partitionKey: btchWire,
          payload: batchFactEnvelope({
            payload: {
              btchId: btchWire,
              tenantId: tenantWire,
              programId: programWire,
              triggerReason: reason,
              unitCount: claimed.length,
              asgnIds: sorted.map((c) => fromUuid('asgn', c.asgn_id)),
            },
            dedupKey: btchWire,
            traceId: oldestTraceId,
          }),
        })

        // SUPERSEDE + RE-ARM (critique fix C2): every other pending max_wait
        // timer on this pool is superseded (the currently-firing MAX_WAIT
        // timer, opts.firingTimerId, Task 9, is deliberately left alone here
        // so claimAndFireDueTimers can mark it fired without a self-conflict),
        // and exactly one fresh max_wait timer is armed. At most one pending
        // timer per pool survives, so a stale timer never prematurely sweeps
        // the next window. Scoped to purpose = 'max_wait' so the "exactly one
        // pending max_wait timer per pool" invariant is explicit: a future
        // non-max_wait timer purpose on the same saga instance is never
        // wrongly superseded here.
        //
        // FOR UPDATE SKIP LOCKED (fix wave 1, cross-transaction deadlock): a
        // plain UPDATE ... WHERE here would try to lock EVERY matching pending
        // max_wait row, including one an in-flight claimAndFireDueTimers MAX_WAIT
        // fire already holds FOR UPDATE (packages/engine's own claim SELECT,
        // Decision 77). That fire's own effect is this very triggerBatch call,
        // opened on a SEPARATE transaction/connection, so this UPDATE and that
        // FOR UPDATE claim can deadlock AB-BA: a concurrent same-pool trigger
        // WITHOUT firingTimerId (LOT_SIZE via onDemandAccrued, or MANUAL) blocks
        // waiting on the row the claim holds, while the claim's own transaction
        // is awaiting (via a JS await) this effect to finish before it can ever
        // release that lock. Postgres cannot detect this cycle (one edge is a
        // JS await, not a DB wait), so it only resolves via Prisma's 5s
        // transaction timeout. The inner subquery locks only the rows it can
        // acquire immediately and skips any already locked by a concurrent
        // fire; a skipped row is safe either way: it is about to be marked
        // 'fired' by its own firing transaction, or it will be superseded on
        // the next trigger. In the single-trigger, no-concurrency case nothing
        // is locked by anyone else, so SKIP LOCKED skips nothing and behavior
        // is unchanged.
        await tx.$executeRaw`
          UPDATE saga_timer SET status = 'superseded'
          WHERE id IN (
            SELECT id FROM saga_timer
            WHERE instance_id = ${pmInstanceId}::uuid AND status = 'pending' AND purpose = 'max_wait'
            AND (${opts.firingTimerId ?? null}::uuid IS NULL OR id <> ${opts.firingTimerId ?? null}::uuid)
            FOR UPDATE SKIP LOCKED
          )
        `
        const cfg = await resolvePoolConfig(tx, tenantWire, programWire)
        await setTimer(
          tx,
          pmInstanceId,
          new Date(Date.now() + cfg.maxWaitSeconds * 1000),
          'max_wait',
        )

        result = { btchId: btchWire, unitCount: claimed.length }
      },
    )

  return result
}

// Non-ops entry point (spec 10d Task 4): enters fulfillment_write FIRST, so
// the shared triggerBatchWithinTx body -- including the onceWithin inbox dedup
// insert (M-role) that precedes its setProgramContext -- runs under the
// non-owner role instead of the table owner. The body's own setProgramContext
// then binds the (single) program for the program-scoped writes (batch,
// pending_pool_entry). The ops entry (manualBatch, spec 10c) enters the scope
// itself via enterWriteScope, so the shared body is left untouched.
export async function triggerBatch(
  db: FulfillmentDb,
  tenantWire: string,
  programWire: string,
  reason: string,
  opts: TriggerBatchOpts,
): Promise<{ btchId: string; unitCount: number } | null> {
  return db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    return triggerBatchWithinTx(tx, tenantWire, programWire, reason, opts)
  })
}

/**
 * Called after a NON-deduped projectDemandFact. Ensures the pool anchor
 * exists, then triggers a LOT_SIZE batch once the POOLED count (HELD is
 * excluded, `pool_status = 'POOLED'`) has reached minLotSize.
 * `epoch = triggerDedupKey`, the demand fact's own dedupKey, so a redelivered
 * demand fact can never double-trigger a LOT_SIZE batch.
 */
export async function onDemandAccrued(
  db: FulfillmentDb,
  tenantWire: string,
  programWire: string,
  triggerDedupKey: string,
  traceId: string,
): Promise<{ triggered: boolean; btchId?: string }> {
  await ensurePool(db, tenantWire, programWire)

  const tenantUuid = toUuid(tenantWire)
  const programUuid = toUuid(programWire)
  const counted = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pending_pool_entry
    WHERE tenant_id = ${tenantUuid}::uuid AND program_id = ${programUuid}::uuid AND pool_status = 'POOLED'
  `
  const count = Number(counted[0]?.n ?? 0)
  const cfg = await resolvePoolConfig(db, tenantWire, programWire)
  if (count < cfg.minLotSize) {
    return { triggered: false }
  }

  const res = await triggerBatch(db, tenantWire, programWire, 'LOT_SIZE', {
    epoch: triggerDedupKey,
    traceId,
  })
  return { triggered: res != null, btchId: res?.btchId }
}

/**
 * The MAX_WAIT trigger (Task 9, check 3b): a thin wrapper over the D77 engine's
 * claimAndFireDueTimers, run on a poll cadence by whatever caller owns
 * scheduling (a cron worker, spec 07 does not fix which). The engine's own
 * transaction claims due timers with FOR UPDATE SKIP LOCKED (decision 77), so
 * concurrent callers of this function claim disjoint timer sets: no timer
 * double-fires and none is skipped (proven in test/batching-timer.test.ts).
 *
 * The effect receives a bare DueTimer (id, instanceId, purpose as uuid text
 * strings) with NO tx handle (the engine contract): claimAndFireDueTimers
 * commits the claim/mark-fired transaction independently of whatever the
 * effect does, so the effect must open its own transaction, which
 * triggerBatch does. This makes the effect at-least-once: a redelivery of the
 * SAME timer (the row is only status-flipped to 'fired', never deleted) must
 * be a safe no-op.
 *
 * Redelivery safety is `epoch: timer.id`: onceWithin's dedup key embeds the
 * firing timer's own id, which is STABLE across redeliveries of the same fire
 * (the row survives, only its status column changes), so a retry after a
 * crash between the effect's commit and claimAndFireDueTimers' mark-fired
 * UPDATE is deduped. A freshly re-armed next-window timer gets a NEW id (an
 * INSERT, not an UPDATE of the old row), so it is never wrongly deduped
 * against the previous window's epoch.
 *
 * `firingTimerId: timer.id` also flows into triggerBatch's supersede sweep so
 * that sweep deliberately EXCLUDES the currently-firing timer: without this,
 * the supersede UPDATE would try to lock the very saga_timer row that the
 * enclosing claimAndFireDueTimers transaction already holds under its own
 * FOR UPDATE SKIP LOCKED claim, deadlocking the effect's own transaction
 * against the transaction that is awaiting it.
 *
 * A miss on the batch_pool lookup (`rows.length === 0`) is a silent no-op, not
 * an anomaly: it means the pool's batch_pool row is gone (never happens in
 * this spec, pools are never deleted) or the timer belongs to some other flow
 * on the same saga_instance table (never true today: batching_pool instances
 * only ever carry max_wait timers). Guarded defensively rather than thrown,
 * since throwing here would abort the WHOLE claim transaction and stall every
 * other due timer in the same claimAndFireDueTimers batch.
 *
 * No traceId flows through this path (documented on TriggerBatchOpts.traceId
 * above): the batch fact's traceId is always the deterministically-oldest
 * claimed pending_pool_entry's trace_id, derived inside triggerBatch.
 *
 * Crash-window note (fix wave 1): if the process crashes between this effect's
 * own transaction commit (the batch, the outbox row, and the supersede/re-arm)
 * and claimAndFireDueTimers' own mark-fired UPDATE, the firing timer transiently
 * reverts to 'pending' on restart and is later marked 'superseded' by an
 * unrelated trigger (the next LOT_SIZE, MANUAL, or MAX_WAIT run on the same
 * pool) instead of ever reaching 'fired'. This is a terminal-status/audit
 * ambiguity only: no double-batch results (epoch = timer.id dedups the retry
 * via onceWithin) and no re-arm is lost (the fresh max_wait timer from the
 * effect's own commit already survived).
 *
 * `batchSize` (fix wave 1) is passed straight through to the engine's
 * claimAndFireDueTimers, defaulting to 100 (unchanged behavior); a caller can
 * override it to cap how many due timers one call claims (used by
 * test/batching-timer.test.ts to force a deterministic split across
 * concurrent workers).
 */
export async function runDueBatchTimers(
  db: FulfillmentDb,
  now: Date,
  batchSize = 100,
): Promise<string[]> {
  return claimAndFireDueTimers(
    db,
    now,
    async (timer) => {
      if (timer.purpose !== 'max_wait') return

      const rows = await db.$queryRaw<{ tenant_id: string; program_id: string }[]>`
        SELECT tenant_id::text AS tenant_id, program_id::text AS program_id
        FROM batch_pool WHERE pm_instance_id = ${timer.instanceId}::uuid
      `
      if (rows.length === 0) return

      const tenantWire = fromUuid('tnnt', rows[0]!.tenant_id)
      const programWire = fromUuid('prog', rows[0]!.program_id)
      await triggerBatch(db, tenantWire, programWire, 'MAX_WAIT', {
        epoch: timer.id,
        firingTimerId: timer.id,
      })
    },
    batchSize,
  )
}

/**
 * The MANUAL trigger (Task 10, check 3c): a class-3 ops action (S13) that
 * creates a Batch below minLotSize, on demand, bypassing the lot-size gate
 * entirely (unlike onDemandAccrued, this never checks the POOLED count).
 *
 * `ensurePool` runs first so the pool anchor (and its first max_wait timer)
 * exists even if this is the very first touch of the pool, then delegates to
 * the shared `triggerBatch('MANUAL', ...)`. The caller-supplied `opsToken` IS
 * the MANUAL idempotency epoch (per the epoch-namespacing rule: MANUAL's
 * epoch is an ops-supplied token, distinct from LOT_SIZE's demand-fact
 * dedupKey and MAX_WAIT's firing timer id), so a re-invocation with the SAME
 * opsToken is deduped by triggerBatch's own onceWithin and creates no second
 * batch.
 *
 * Actor recording: `triggerBatch` already writes
 * `triggered_by_actor = ${opts.actorUuid ?? null}::uuid` on the batch INSERT
 * (Task 8). `actorUuid` here is `actor.operatorId` directly: in v1 the caller
 * (a test fixture today, the step-9 ops-portal edge later) supplies
 * `operatorId` as a uuid string already. Real class-3 principal resolution
 * (resolving an authenticated ops session to that uuid) is the step-9 portal
 * edge's job, and the tamper-evident 6e audit-store write is ALSO deferred to
 * step 9 (C4: fulfillment cannot write Auth's 6e store); v1 records only
 * `batch.triggered_by_actor`.
 *
 * Returns null when nothing was POOLED (nothing to batch) or the opsToken was
 * already processed (deduped).
 */
export async function manualTrigger(
  db: FulfillmentDb,
  tenantWire: string,
  programWire: string,
  actor: OpsActor,
  opsToken: string,
  traceId: string,
): Promise<{ btchId: string } | null> {
  await ensurePool(db, tenantWire, programWire)

  const res = await triggerBatch(db, tenantWire, programWire, 'MANUAL', {
    epoch: opsToken,
    actorUuid: actor.operatorId,
    traceId,
  })
  return res ? { btchId: res.btchId } : null
}

/**
 * record-HOLD (Task 10, check 3d): moves one POOLED pending_pool_entry to
 * HELD, excluding it from every future trigger. `pending_pool_entry` is
 * PROGRAM-SCOPED (07.B), and this function is only given an asgnId (no
 * programId), so it must look the row's own program_id up FIRST and set the
 * program context before the write-gated UPDATE (critique fix).
 *
 * ONE db.$transaction: the program_id SELECT and the HELD UPDATE run under
 * the same tx so the program context set via `setProgramContext` is visible
 * to the UPDATE (SET LOCAL is transaction-scoped).
 *
 * The `AND pool_status = 'POOLED'` guard on the UPDATE means an already-HELD
 * or already-BATCHED entry is left untouched (no-op, not an error): a HOLD is
 * only ever a POOLED -> HELD transition, never a re-hold or an un-batch.
 *
 * HELD entries are ALREADY excluded from every trigger: `onDemandAccrued`'s
 * POOLED count and `triggerBatch`'s mark-BATCHED claim both filter
 * `pool_status = 'POOLED'` (unchanged by this task; verified, not modified).
 *
 * Actor recording: `held_by_actor`/`held_at` were added to the schema in
 * Task 2 (critique fix). As with `manualTrigger`, `actor.operatorId` is
 * written directly as the uuid; the tamper-evident 6e audit-store write is
 * deferred to step 9 (C4), same deferral as above.
 *
 * A no-op (nothing found for asgnId) resolves silently: there is nothing to
 * hold, which is not an error condition for this class-3 op.
 */
// Injected-tx variant (spec 10c Task 4): the current body verbatim minus the
// db.$transaction wrapper. holdEntry (below) delegates to this.
export async function holdEntryWithinTx(tx: Tx, asgnIdWire: string, actor: OpsActor): Promise<void> {
  const asgnUuid = toUuid(asgnIdWire)

  const rows = await tx.$queryRaw<{ program_id: string }[]>`
    SELECT program_id::text AS program_id FROM pending_pool_entry WHERE asgn_id = ${asgnUuid}::uuid
  `
  if (rows.length === 0) return // nothing to hold

  await setProgramContext(tx, rows[0]!.program_id)

  await tx.$executeRaw`
    UPDATE pending_pool_entry
    SET pool_status = 'HELD', held_by_actor = ${actor.operatorId}::uuid, held_at = now(), updated_at = now()
    WHERE asgn_id = ${asgnUuid}::uuid AND pool_status = 'POOLED'
  `
}

// Non-ops entry point (spec 10d Task 4): enters fulfillment_write FIRST so the
// shared holdEntryWithinTx body runs under the non-owner role; the body's own
// setProgramContext (resolved server-side from the target's pending_pool_entry
// row) then binds the program for the HELD UPDATE. The ops entry (holdRecord,
// spec 10c) enters the scope itself, so the shared body is left untouched.
export async function holdEntry(db: FulfillmentDb, asgnIdWire: string, actor: OpsActor): Promise<void> {
  await db.$transaction(async (tx: Tx) => {
    await enterWriteRole(tx, 'fulfillment_write')
    await holdEntryWithinTx(tx, asgnIdWire, actor)
  })
}
