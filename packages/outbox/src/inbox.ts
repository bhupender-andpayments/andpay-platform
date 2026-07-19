import type { OutboxTx } from './types.js'

function assertTransactionClient(tx: OutboxTx): void {
  if ('$transaction' in tx) {
    throw new Error(
      'onceWithin must be called with a transaction client (the tx from $transaction), not the base client',
    )
  }
}

/**
 * Run `fn` at most once for a given (consumer, dedupKey), inside the caller's
 * transaction (E6, effectively-once). Inserts the inbox row; on a primary-key
 * conflict it SKIPS (already processed) and returns false. Otherwise it runs
 * `fn` and returns true, and the inbox row plus the effect commit together.
 *
 * If `fn` throws, the transaction rolls back, including the inbox insert, so the
 * effect is retried on redelivery. There is NO money floor here (S20); this is
 * the local non-ledger effectively-once mechanism only. No cross-service
 * transaction exists anywhere (E6).
 */
export async function onceWithin(
  tx: OutboxTx,
  consumer: string,
  dedupKey: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  assertTransactionClient(tx)
  const inserted = await tx.$executeRaw`
    INSERT INTO inbox (consumer, dedup_key)
    VALUES (${consumer}, ${dedupKey})
    ON CONFLICT (consumer, dedup_key) DO NOTHING
  `
  if (inserted === 0) return false
  await fn()
  return true
}
