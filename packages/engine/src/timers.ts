import type { DueTimer, EngineClient, EngineTx } from './types.js'

/**
 * Set a durable timer for an instance. Written on the caller's transaction so it
 * commits with the step that scheduled it (E1).
 */
export async function setTimer(
  tx: EngineTx,
  instanceId: string,
  fireAt: Date,
  purpose: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO saga_timer (instance_id, fire_at, purpose, status)
    VALUES (${instanceId}::uuid, ${fireAt}, ${purpose}, 'pending')
  `
}

/**
 * Claim all due timers with FOR UPDATE SKIP LOCKED (decision 77), fire each via
 * the effect, and mark it fired, all in one transaction. Concurrent workers
 * claim disjoint sets, so no timer double-fires and none is skipped. The effect
 * and the mark-fired commit together; a rollback leaves the timer pending
 * (at-least-once, the effect must be idempotent). Returns the fired timer ids.
 */
export async function claimAndFireDueTimers(
  client: EngineClient,
  now: Date,
  effect: (timer: DueTimer) => Promise<void>,
  batchSize = 100,
): Promise<string[]> {
  return client.$transaction(async (tx) => {
    const due = await tx.$queryRaw<
      { id: string; instance_id: string; purpose: string }[]
    >`
      SELECT id::text AS id, instance_id::text AS instance_id, purpose
      FROM saga_timer
      WHERE status = 'pending' AND fire_at <= ${now}
      ORDER BY fire_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `
    const fired: string[] = []
    for (const row of due) {
      await effect({ id: row.id, instanceId: row.instance_id, purpose: row.purpose })
      await tx.$executeRaw`
        UPDATE saga_timer SET status = 'fired', claimed_at = now() WHERE id = ${row.id}::uuid
      `
      fired.push(row.id)
    }
    return fired
  })
}
