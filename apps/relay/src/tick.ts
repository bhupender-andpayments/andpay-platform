import { relayOnce, type OutboxClient, type PublisherPort } from '@andpay/outbox'
import { withRole, type TransactionalClient } from './role-client.js'
import type { RelayContext } from './contexts.js'

export interface DrainResult {
  readonly context: string
  /** Rows published this drain. 0 means the outbox was empty: a safe no-op. */
  readonly published: number
  /**
   * Set when this context's drain threw. One context failing must NOT stop the
   * others: they are independent databases under independent roles, and a
   * fulfillment outage silently halting identity's rail would be a much worse
   * failure than the one that caused it.
   */
  readonly error?: Error
}

export interface RelayDeps {
  /** One entry per context in RELAY_CONTEXTS, keyed by context name. */
  readonly clients: ReadonlyMap<string, TransactionalClient>
  readonly publisher: PublisherPort
  readonly contexts: readonly RelayContext[]
  /**
   * Rows claimed per drain. relayOnce defaults to 100. The demo pump had to
   * raise this to 5000 to work around its own lack of a retry ladder; that
   * workaround must NOT be carried over here (task B-2). A small batch keeps
   * the claim transaction short, which is the whole point of GO_LIVE_BLOCKERS
   * 2.3.
   */
  readonly batchSize?: number
}

/**
 * Drain every context outbox once.
 *
 * Stateless and one-shot, exactly like the scheduler's `runBatchingTick`: no
 * env reads, no process.exit, no timers. The unit the loop calls repeatedly is
 * the same unit a test calls directly.
 *
 * Contexts are drained SEQUENTIALLY rather than concurrently. The relay is
 * IO-light (claim, publish, stamp: milliseconds), so there is nothing to gain,
 * and sequential drains keep at most one claim transaction open at a time,
 * which matters because these transactions hold FOR UPDATE SKIP LOCKED rows.
 *
 * Concurrent relay INSTANCES are safe regardless: the claim is FOR UPDATE SKIP
 * LOCKED, so two relays partition the outbox between them rather than
 * double-publishing. Delivery is at-least-once (E2) and every consumer dedups
 * on the envelope dedup key via the inbox (E6), so a republish after a crash
 * between publish and stamp is absorbed by design.
 */
export async function runRelayTick(deps: RelayDeps): Promise<DrainResult[]> {
  const results: DrainResult[] = []
  for (const context of deps.contexts) {
    const client = deps.clients.get(context.name)
    if (client === undefined) {
      results.push({
        context: context.name,
        published: 0,
        error: new Error(`no client configured for relay context "${context.name}"`),
      })
      continue
    }
    try {
      const published = await relayOnce(
        withRole(client, context.role) as unknown as OutboxClient,
        deps.publisher,
        deps.batchSize !== undefined ? { batchSize: deps.batchSize } : {},
      )
      results.push({ context: context.name, published })
    } catch (err: unknown) {
      results.push({
        context: context.name,
        published: 0,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }
  return results
}
