import type {
  OutboxClient,
  OutboxMessage,
  OutboxRelayTx,
  PublisherPort,
} from './types.js'

interface RawOutboxRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  partition_key: string
  payload: unknown
  headers: Record<string, unknown> | null
  created_at: Date
}

export interface RelayOptions {
  /** Maximum rows to publish per call. */
  batchSize?: number
}

function toMessage(row: RawOutboxRow): OutboxMessage {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    partitionKey: row.partition_key,
    payload: row.payload,
    headers: row.headers,
    createdAt: row.created_at,
  }
}

/**
 * Publish one batch of unpublished outbox rows in created_at order, then stamp
 * published_at. Returns the number published. A re-run publishes nothing new
 * once rows are stamped.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED (decision 77) so concurrent
 * relay workers never double-claim. Delivery is at-least-once: publish happens
 * before the stamp, so a crash between them re-publishes on the next run and the
 * consumer dedupes (E2, E6). The publish call is intentionally inside the claim
 * transaction for the in-memory and log sinks; the MSK adapter refines this seam
 * in a later spec.
 */
export async function relayOnce(
  client: OutboxClient,
  publisher: PublisherPort,
  options: RelayOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 100
  return client.$transaction(async (tx: OutboxRelayTx) => {
    const rows = await tx.$queryRaw<RawOutboxRow[]>`
      SELECT id::text AS id, aggregate_type, aggregate_id, event_type,
             partition_key, payload, headers, created_at
      FROM outbox
      WHERE published_at IS NULL
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `
    if (rows.length === 0) return 0

    await publisher.publish(rows.map(toMessage))

    for (const row of rows) {
      await tx.$executeRaw`UPDATE outbox SET published_at = now() WHERE id = ${row.id}::uuid`
    }
    return rows.length
  })
}
