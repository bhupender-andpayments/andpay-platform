import type { Kafka } from 'kafkajs'
import { onceWithin } from '@andpay/outbox'
import { toUuid } from '@andpay/ids'
import { runFactConsumer, type ConsumerHandle } from '@andpay/bus'
import type { Envelope } from '@andpay/envelope'
import type { AnalyticsDb } from './db.js'
import { enterWriteRole } from './write-context.js'
import { bumpWatermark } from './watermark.js'
import { applyOnline } from './project.js'
import { ANALYTICS_CONSUMER, ANALYTICS_TOPICS } from './topics.js'

/**
 * Resolve the typed program id a fact carries to its native uuid, or null when
 * the fact has no program field. Only two of the nine consumed facts carry a
 * program directly: the assignment fact (progId) and the batch fact (programId).
 * The rest (ship_to_amended, replacement_raised, activated, unit, print_for,
 * dispatch, shipment) carry none; their raw row lands with program_id NULL and
 * the modeled row resolves program via the asgn link in Task 3. This reads only
 * the fact's OWN payload (no DB lookup, no cross-context read; C4), so it is
 * safe to resolve before the dedup guard. Precedent: the Fulfillment pool
 * projectDemandFact's toUuid(p.progId) on the fact's own progId.
 */
export function programIdOf(env: Envelope): string | null {
  const payload = env.payload as Record<string, unknown>
  const typedId = payload.progId ?? payload.programId
  return typeof typedId === 'string' ? toUuid(typedId) : null
}

/**
 * Ingest one consumed fact into the analytics rail. One tx per envelope. The
 * ordering is load-bearing:
 *   1. enter analytics_write FIRST, before the leading onceWithin inbox insert
 *      (the 10d landmine: otherwise that leading write runs as the table owner).
 *   2. dedup on the inbox by {ANALYTICS_CONSUMER, envelope_id} (E6, no M7 money
 *      floor: this rail holds no money, S20). A redelivered envelope is a no-op.
 *   3. persist the fact append-only into raw_event BEFORE any modeled touch
 *      (check 5, raw-then-modeled), then the modeled applyOnline stub, then bump
 *      the watermark. All commit together, or roll back together on throw.
 * Returns { deduped: true } when the envelope was already processed.
 */
export async function ingestEnvelope(db: AnalyticsDb, env: Envelope): Promise<{ deduped: boolean }> {
  let wrote = false
  await db.$transaction(async (tx) => {
    await enterWriteRole(tx, 'analytics_write') // FIRST, before onceWithin
    await onceWithin(tx, ANALYTICS_CONSUMER, env.id, async () => {
      const programId = programIdOf(env)
      await tx.$executeRaw`
        INSERT INTO raw_event (envelope_id, topic, type, schema_version, aggregate_id, program_id, occurred_at, payload)
        VALUES (${env.id}, ${env.type}, ${env.type}, ${env.version}, ${env.subject}, ${programId}::uuid,
                ${new Date(env.timestamp)}, ${JSON.stringify(env.payload)}::jsonb)` // RAW FIRST
      await applyOnline(tx, env) // THEN the modeled upsert (Task 3 fills the stub)
      await bumpWatermark(tx, env.type, new Date(env.timestamp), env.id)
      wrote = true
    })
  })
  return { deduped: !wrote }
}

/**
 * Wire the rail's own fact consumer group over the nine subscribed topics. A
 * LIBRARY consumer (harness-proven): it builds and returns the handle but starts
 * no production daemon here (no long-running process, no top-level .run() at
 * import). Each decoded envelope is ingested effectively-once via the inbox.
 */
export async function runAnalyticsConsumer(kafka: Kafka, db: AnalyticsDb): Promise<ConsumerHandle> {
  return runFactConsumer(kafka, {
    groupId: ANALYTICS_CONSUMER,
    topics: ANALYTICS_TOPICS,
    onEnvelope: (env) => ingestEnvelope(db, env).then(() => {}),
  })
}
