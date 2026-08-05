import { runDueBatchTimers, type FulfillmentDb } from '@andpay/fulfillment-service'

/**
 * The stateless, one-shot batching tick (Phase 6 task D-J, R2).
 *
 * This is a THIN, PURE wrapper over the already-built D77 engine driver
 * `runDueBatchTimers` (services/fulfillment/src/batching.ts): it claims every
 * DUE max_wait timer (FOR UPDATE SKIP LOCKED, decision 77) and fires each as a
 * MAX_WAIT batch. LOT_SIZE is already event-driven (onDemandAccrued, called
 * from the fulfillment demand-projection path) and MANUAL is a class-3 ops
 * action (manualTrigger); this scheduler owns ONLY the MAX_WAIT poll.
 *
 * No process.exit, no env reads, no logging side effects: it is the exact
 * unit prod invokes once per EventBridge/CronJob fire, and the exact unit a
 * test calls directly. Overlapping invocations (two concurrent ticks, or a
 * redelivered fire after a crash) are engine-safe: SKIP LOCKED partitions due
 * timers across concurrent callers with no double-fire and no skip, and
 * redelivery of the SAME timer is deduped by its stable epoch (timer.id).
 *
 * Returns the ids of the saga_timer rows that fired this tick. An empty array
 * means nothing was due: a safe no-op.
 */
export async function runBatchingTick(db: FulfillmentDb, now: Date): Promise<string[]> {
  return runDueBatchTimers(db, now)
}
