import type { OutboxEvent, OutboxTx } from './types.js'

function assertTransactionClient(tx: OutboxTx): void {
  // A Prisma interactive transaction client does not expose $transaction; the
  // base client does. Enqueuing on the base client would not be atomic with any
  // state change (E1), so reject it.
  if ('$transaction' in tx) {
    throw new Error(
      'enqueue must be called with a transaction client (the tx from $transaction), not the base client',
    )
  }
}

/**
 * Write an outbox row INSIDE the caller's transaction (E1). The state change and
 * this fact commit atomically or not at all. IDs-only payload, no PII (S7), no
 * secrets (S4).
 */
export async function enqueue(tx: OutboxTx, event: OutboxEvent): Promise<void> {
  assertTransactionClient(tx)
  const headers =
    event.headers === undefined ? null : JSON.stringify(event.headers)
  await tx.$executeRaw`
    INSERT INTO outbox (aggregate_type, aggregate_id, event_type, partition_key, payload, headers)
    VALUES (
      ${event.aggregateType},
      ${event.aggregateId},
      ${event.eventType},
      ${event.partitionKey},
      ${JSON.stringify(event.payload)}::jsonb,
      ${headers}::jsonb
    )
  `
}
